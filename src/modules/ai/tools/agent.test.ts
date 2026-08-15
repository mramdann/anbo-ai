import { useManagedAgentsStore } from "@/modules/agents/store/managedAgentsStore";
import type { ToolExecutionOptions } from "ai";
import { beforeEach, describe, expect, it } from "vitest";
import { buildManagedAgentTools } from "./agent";
import type { ToolContext } from "./context";

const toolOptions: ToolExecutionOptions = {
  toolCallId: "tool-call",
  messages: [],
};

function makeContext(): ToolContext {
  return {
    getCwd: () => "C:/workspace",
    getWorkspaceRoot: () => "C:/workspace",
    getWorkspaceEnv: () => ({ kind: "local" }),
    getTerminalContext: () => null,
    isActiveTerminalPrivate: () => false,
    injectIntoActivePty: () => false,
    openBrowser: () => false,
    navigateBrowser: () => false,
    getActiveBrowserTabId: () => null,
    switchBrowserTab: () => false,
    closeBrowserTab: () => false,
    spawnAgent: () => null,
    readAgentOutput: () => "Claude Code is waiting for workspace trust",
    readCache: new Map(),
    getSessionId: () => "session-1",
  };
}

beforeEach(() => {
  useManagedAgentsStore.setState({ agents: {} });
});

describe("managed Claude Code tools", () => {
  it("keeps a startup timeout active with readable output and its pending task", async () => {
    const store = useManagedAgentsStore.getState();
    store.register({
      leafId: 7,
      tabId: 8,
      sessionId: "session-1",
      task: "Inspect the workspace",
      cwd: "C:/workspace",
    });
    store.setPhase(7, "attention");

    const execute = buildManagedAgentTools(makeContext()).read_agent_output
      .execute;
    if (!execute) throw new Error("read_agent_output has no execute");
    const result = (await execute({}, toolOptions)) as Record<string, unknown>;

    expect(result.active).toBe(true);
    expect(result.phase).toBe("attention");
    expect(result.pending_task).toBe("Inspect the workspace");
    expect(result.output).toContain("workspace trust");
  });
});
