import { usePreferencesStore } from "@/modules/settings/preferences";
import { create } from "zustand";

type State = {
  /** Workspaces whose restored tabs wait for the user's word, this launch. */
  pending: ReadonlySet<string>;
  ask: (spaceIds: readonly string[]) => void;
  release: (spaceId: string) => void;
};

export const useResumeGate = create<State>((set, get) => ({
  pending: new Set(),

  ask: (spaceIds) => {
    const pending = get().pending;
    if (spaceIds.every((id) => pending.has(id))) return;
    set({ pending: new Set([...pending, ...spaceIds]) });
  },

  release: (spaceId) => {
    const pending = get().pending;
    if (!pending.has(spaceId)) return;
    const next = new Set(pending);
    next.delete(spaceId);
    set({ pending: next });
  },
}));

const NONE: ReadonlySet<string> = new Set();

/** The workspaces that wait, or none while the question is off in Settings. */
export function resumePendingFor(
  pending: ReadonlySet<string>,
  askBeforeResume: boolean,
): ReadonlySet<string> {
  return askBeforeResume ? pending : NONE;
}

export function useResumePending(): ReadonlySet<string> {
  const pending = useResumeGate((state) => state.pending);
  const ask = usePreferencesStore((state) => state.askBeforeResume);
  return resumePendingFor(pending, ask);
}
