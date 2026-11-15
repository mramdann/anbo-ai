import { useAgentStore } from "@/modules/agents/store/agentStore";
import { useLspRuntimeStore } from "@/modules/lsp/lib/runtimeStore";
import { useSpaces } from "@/modules/spaces/lib/useSpaces";
import type { Tab } from "@/modules/tabs/lib/useTabs";
import { ptyIdForLeaf } from "@/modules/terminal/lib/useTerminalSession";
import { useMemo } from "react";
import { type AgentInfo, buildUsageModel, type UsageModel } from "./usageModel";
import { useUsageSnapshot } from "./useUsageSnapshot";

/**
 * Anbo's usage by workspace while `enabled` (the usage view or the spaces
 * menu is open); null while closed or before the first read.
 */
export function useUsageModel(
  enabled: boolean,
  tabs: readonly Tab[],
): UsageModel | null {
  const snapshot = useUsageSnapshot(enabled);
  // Closed, the stores are not watched: a selector that gives null re-renders
  // nothing when they change. App holds this hook for the spaces menu and
  // otherwise reads the agent store without re-rendering on its changes.
  const spaces = useSpaces((s) => (enabled ? s.spaces : null));
  const agentSessions = useAgentStore((s) => (enabled ? s.sessions : null));
  const lspSessions = useLspRuntimeStore((s) => (enabled ? s.sessions : null));
  return useMemo(() => {
    if (!snapshot || !spaces || !agentSessions || !lspSessions) return null;
    const agents: Record<number, AgentInfo> = {};
    for (const session of Object.values(agentSessions)) {
      agents[session.leafId] = {
        name: session.name,
        agent: session.agent,
        status: session.status,
      };
    }
    return buildUsageModel(snapshot, {
      spaces,
      tabs,
      ptyIdForLeaf,
      agents,
      servers: Object.values(lspSessions).map((session) => ({
        root: session.root,
        presetId: session.presetId,
      })),
    });
  }, [snapshot, spaces, tabs, agentSessions, lspSessions]);
}

/** Each workspace's total, for the spaces menu. */
export function usageBySpace(
  model: UsageModel | null,
): ReadonlyMap<string, { memory: number; cpu: number | null }> | null {
  if (!model?.supported) return null;
  return new Map(
    model.workspaces.map((workspace) => [
      workspace.spaceId,
      { memory: workspace.memory, cpu: workspace.cpu },
    ]),
  );
}
