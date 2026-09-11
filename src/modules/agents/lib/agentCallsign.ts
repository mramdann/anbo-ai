import { useAgentStore } from "@/modules/agents/store/agentStore";
import { ptyIdForLeaf } from "@/modules/terminal/lib/useTerminalSession";

/**
 * What the agent in a given terminal goes by.
 *
 * The browser side knows which terminal is driving a tab but not who that is;
 * this window mints the callsign and is the only place that can answer. A CLI
 * brand cannot: several agents of the same CLI drive tabs at the same time, so
 * "Claude" on three tabs names none of them.
 */
export function agentCallsign(ptyId: number | undefined): string | null {
  if (ptyId === undefined) return null;
  for (const session of Object.values(useAgentStore.getState().sessions)) {
    if (ptyIdForLeaf(session.leafId) === ptyId) return session.name || null;
  }
  return null;
}

export function useAgentCallsign(ptyId: number | undefined): string | null {
  return useAgentStore((state) => {
    if (ptyId === undefined) return null;
    for (const session of Object.values(state.sessions)) {
      if (ptyIdForLeaf(session.leafId) === ptyId) return session.name || null;
    }
    return null;
  });
}
