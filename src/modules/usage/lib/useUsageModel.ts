import { useAgentStore } from "@/modules/agents/store/agentStore";
import { useLspRuntimeStore } from "@/modules/lsp/lib/runtimeStore";
import { useSpaces } from "@/modules/spaces/lib/useSpaces";
import type { Tab } from "@/modules/tabs/lib/useTabs";
import { ptyIdForLeaf } from "@/modules/terminal/lib/useTerminalSession";
import { useMemo } from "react";
import { type AgentInfo, buildUsageModel, type UsageModel } from "./usageModel";
import { useUsageSnapshot } from "./useUsageSnapshot";

/**
 * Anbo's usage by workspace; null before the first read. Only the usage
 * view's body holds this hook, and that body exists only while the view is
 * open: closed, nothing reads and no store is watched. Keep it out of App,
 * which reads the agent store without re-rendering on its changes.
 */
export function useUsageModel(tabs: readonly Tab[]): UsageModel | null {
  const snapshot = useUsageSnapshot();
  const spaces = useSpaces((s) => s.spaces);
  const agentSessions = useAgentStore((s) => s.sessions);
  const lspSessions = useLspRuntimeStore((s) => s.sessions);
  return useMemo(() => {
    if (!snapshot) return null;
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
