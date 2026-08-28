import type { ToolExecutionOptions } from "ai";
import { describe, expect, it, vi } from "vitest";
import type { ToolContext } from "./context";
import { buildTerminalTools } from "./terminal";

const toolOptions: ToolExecutionOptions = {
  toolCallId: "tool-call",
  messages: [],
};

function context(
  sharedTerminalRequest: NonNullable<ToolContext["sharedTerminalRequest"]>,
): ToolContext {
  return {
    getCwd: () => "C:/workspace",
    getWorkspaceRoot: () => "C:/workspace",
    getWorkspaceEnv: () => ({ kind: "local" }),
    getTerminalContext: () => null,
    isActiveTerminalPrivate: () => false,
    injectIntoActivePty: () => false,
    sharedTerminalRequest,
    openBrowser: () => false,
    navigateBrowser: () => false,
    getActiveBrowserTabId: () => null,
    switchBrowserTab: () => false,
    closeBrowserTab: () => false,
    spawnAgent: () => null,
    readAgentOutput: () => null,
    readCache: new Map(),
    getSessionId: () => "session",
  };
}

describe("AI shared terminal tools", () => {
  it("routes list and read through the workspace-frozen terminal bridge", async () => {
    const request = vi.fn(async () => ({ result: { ok: true } }));
    const tools = buildTerminalTools(context(request));
    if (
      !tools.terminal_list.execute ||
      !tools.terminal_read.execute ||
      !tools.terminal_wait.execute ||
      !tools.terminal_interrupt.execute
    ) {
      throw new Error("shared terminal tools have no execute handler");
    }

    if (!tools.terminal_open.execute || !tools.terminal_close.execute) {
      throw new Error("terminal lifecycle tools have no execute handler");
    }
    await tools.terminal_open.execute({ title: "Tests" }, toolOptions);
    await tools.terminal_close.execute(
      { terminalId: "terminal:20:201" },
      toolOptions,
    );
    await tools.terminal_list.execute({}, toolOptions);
    await tools.terminal_read.execute(
      { terminalId: "terminal:10:101", cursor: "v1:1:4", maxChars: 500 },
      toolOptions,
    );
    await tools.terminal_wait.execute(
      {
        terminalId: "terminal:10:101",
        executionId: "terminal-execution:10:101:1",
        timeout: 500,
        maxChars: 700,
      },
      toolOptions,
    );
    await tools.terminal_interrupt.execute(
      {
        terminalId: "terminal:10:101",
        executionId: "terminal-execution:10:101:1",
      },
      toolOptions,
    );

    expect(request).toHaveBeenNthCalledWith(1, "terminal_open", {
      title: "Tests",
    });
    expect(request).toHaveBeenNthCalledWith(2, "terminal_close", {
      terminalId: "terminal:20:201",
    });
    expect(request).toHaveBeenNthCalledWith(3, "terminal_list", {});
    expect(request).toHaveBeenNthCalledWith(4, "terminal_read", {
      terminalId: "terminal:10:101",
      cursor: "v1:1:4",
      maxChars: 500,
    });
    expect(request).toHaveBeenNthCalledWith(5, "terminal_wait", {
      terminalId: "terminal:10:101",
      executionId: "terminal-execution:10:101:1",
      timeout: 500,
      maxChars: 700,
    });
    expect(request).toHaveBeenNthCalledWith(6, "terminal_interrupt", {
      terminalId: "terminal:10:101",
      executionId: "terminal-execution:10:101:1",
    });
  });

  it("marks visible insert and execute operations for approval", () => {
    const tools = buildTerminalTools(context(vi.fn()));
    expect(tools.terminal_insert.needsApproval).toBe(true);
    expect(tools.terminal_open.needsApproval).toBe(true);
    expect(tools.terminal_close.needsApproval).toBe(true);
    expect(tools.terminal_execute.needsApproval).toBe(true);
    expect(tools.terminal_interrupt.needsApproval).toBe(true);
  });

  it("rejects a dangerous command before it reaches the shared terminal", async () => {
    const request = vi.fn(async () => ({ result: { ok: true } }));
    const execute = buildTerminalTools(context(request)).terminal_execute
      .execute;
    if (!execute) throw new Error("terminal_execute has no execute handler");

    const result = await execute(
      { terminalId: "terminal:10:101", text: "rm -rf /" },
      toolOptions,
    );

    expect(result).toHaveProperty("error");
    expect(request).not.toHaveBeenCalled();
  });
});
