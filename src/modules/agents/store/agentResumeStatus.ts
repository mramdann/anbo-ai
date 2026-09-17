import { create } from "zustand";

/**
 * Per-leaf resume lifecycle, surfaced on the agent's terminal tab so a restore
 * that quietly fell back to a bare shell is no longer invisible.
 *
 * - `resuming`: the tab was warmed and its agent is being brought back (waiting
 *   on the resource guard and/or the resume command). Cleared once the agent
 *   actually shows activity, so a healthy resume never keeps a spinner.
 * - `failed`: the resource guard gave up (the classic "some workspaces came
 *   back as a terminal" case). Stays until the agent exits or is relaunched.
 *
 * Keyed by leaf id — the same id the resume orchestration and the tab render
 * both already work with.
 */
export type AgentResumePhase = "resuming" | "failed";

type AgentResumeStatusState = {
  status: Record<number, AgentResumePhase>;
  setStatus: (leafId: number, phase: AgentResumePhase) => void;
  clear: (leafId: number) => void;
};

export const useAgentResumeStatus = create<AgentResumeStatusState>((set) => ({
  status: {},
  setStatus: (leafId, phase) =>
    set((state) =>
      state.status[leafId] === phase
        ? state
        : { status: { ...state.status, [leafId]: phase } },
    ),
  clear: (leafId) =>
    set((state) => {
      if (state.status[leafId] === undefined) return state;
      const next = { ...state.status };
      delete next[leafId];
      return { status: next };
    }),
}));

/** Aggregate the resume phase across a tab's leaves: failed wins over resuming. */
export function tabResumePhase(
  status: Record<number, AgentResumePhase>,
  leafIds: Iterable<number>,
): AgentResumePhase | null {
  let resuming = false;
  for (const id of leafIds) {
    const phase = status[id];
    if (phase === "failed") return "failed";
    if (phase === "resuming") resuming = true;
  }
  return resuming ? "resuming" : null;
}
