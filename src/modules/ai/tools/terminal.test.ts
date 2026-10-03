import { describe, expect, it, vi } from "vitest";
import type { ToolContext } from "./context";
import { buildTerminalTools } from "./terminal";
import { makeToolContext, toolOptions } from "./tools.fixtures";

function context(
  sharedTerminalRequest: NonNullable<ToolContext["sharedTerminalRequest"]>,
): ToolContext {
  return makeToolContext({
    getCwd: () => "C:/workspace",
    getWorkspaceRoot: () => "C:/workspace",
    sharedTerminalRequest,
  });
}

describe("AI shared terminal tools", () => {
  it("routes list and read through the workspace-frozen terminal bridge", async () => {
    const request = vi.fn(async () => ({ result: { ok: true } }));
    const tools = buildTerminalTools(context(request)).tools;
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
    const { approval } = buildTerminalTools(context(vi.fn()));
    expect(approval).toEqual({
      terminal_open: "user-approval",
      terminal_close: "user-approval",
      terminal_interrupt: "user-approval",
      terminal_insert: "user-approval",
      terminal_execute: "user-approval",
    });
  });

  it("rejects a dangerous command before it reaches the shared terminal", async () => {
    const request = vi.fn(async () => ({ result: { ok: true } }));
    const execute = buildTerminalTools(context(request)).tools.terminal_execute
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
