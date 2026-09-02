import type { SpaceMeta } from "@/modules/spaces/lib/store";
import type { TerminalTab } from "@/modules/tabs";
import { describe, expect, it, vi } from "vitest";
import {
  collectSharedTerminals,
  createTerminalAutomationService,
  sanitizeTerminalInput,
  sanitizeTerminalTitle,
  type TerminalAutomationDependencies,
} from "./terminalAutomation";

const workspaceRoot = "C:/work/alpha";

const workspace: SpaceMeta = {
  id: "space-a",
  name: "Alpha",
  root: workspaceRoot,
  env: { kind: "local" },
  createdAt: 1,
  updatedAt: 1,
};

function terminal(overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id: 10,
    kind: "terminal",
    title: "Terminal",
    spaceId: "space-a",
    cwd: "C:/work/alpha",
    paneTree: { kind: "leaf", id: 101, cwd: "C:/work/alpha/app" },
    activeLeafId: 101,
    ...overrides,
  };
}

function dependencies(
  overrides: Partial<TerminalAutomationDependencies> = {},
): TerminalAutomationDependencies {
  return {
    getTabs: () => [terminal()],
    getSpaces: () => [workspace],
    getSessions: () => ({}),
    getActiveTabId: () => 10,
    getBuffer: () => "PS C:\\work\\alpha> ready",
    getSessionState: () => ({
      ready: true,
      shellExited: false,
      commandRunning: false,
      blockMode: "prompt",
      commandGeneration: 2,
      lastExitCode: 0,
      shell: "pwsh",
      columns: 120,
      rows: 30,
      inputPending: false,
    }),
    hasForegroundProcess: async () => false,
    prepare: () => true,
    open: () => ({ tabId: 20, leafId: 201 }),
    close: () => true,
    write: () => true,
    ...overrides,
  };
}

describe("shared terminal discovery", () => {
  it("lists normal terminal leaves with stable ids and excludes protected tabs", async () => {
    const privateTab = terminal({
      id: 11,
      private: true,
      paneTree: { kind: "leaf", id: 111 },
      activeLeafId: 111,
    });
    const agentTab = terminal({
      id: 12,
      agent: {
        launcherId: "claude",
        icon: "claude",
        label: "Claude",
        name: "Claude",
      },
      paneTree: { kind: "leaf", id: 121 },
      activeLeafId: 121,
    });
    const discoveredAgent = terminal({
      id: 13,
      paneTree: { kind: "leaf", id: 131 },
      activeLeafId: 131,
    });
    const result = await collectSharedTerminals(
      dependencies({
        getTabs: () => [terminal(), privateTab, agentTab, discoveredAgent],
        getSessions: () => ({
          131: {
            leafId: 131,
            tabId: 13,
            agent: "codex",
            name: "Codex",
            status: "waiting",
            phase: "finished",
            startedAt: 1,
            lastActivityAt: 1,
            attentionSince: null,
          },
        }),
      }),
      { id: workspace.id, root: workspaceRoot },
    );

    expect(result).toEqual([
      expect.objectContaining({
        terminalId: "terminal:10:101",
        cwd: "C:/work/alpha/app",
        active: true,
        status: "idle",
        shell: "pwsh",
        columns: 120,
        rows: 30,
      }),
    ]);
  });

  it("reports a foreground process as busy", async () => {
    const result = await collectSharedTerminals(
      dependencies({ hasForegroundProcess: async () => true }),
      { id: workspace.id, root: workspaceRoot },
    );
    expect(result[0].status).toBe("busy");
  });
});

describe("shared terminal input", () => {
  it("requires a bounded purpose-specific title when spawning", () => {
    expect(sanitizeTerminalTitle(" Dev Server ")).toEqual({
      ok: true,
      title: "Dev Server",
    });
    expect(sanitizeTerminalTitle(" ")).toMatchObject({ ok: false });
    expect(sanitizeTerminalTitle("one\ntwo")).toMatchObject({ ok: false });
    expect(sanitizeTerminalTitle("x".repeat(65))).toMatchObject({ ok: false });
  });

  it("opens a titled terminal in the selected workspace without focus", async () => {
    const open = vi.fn(() => ({ tabId: 20, leafId: 201 }));
    const service = createTerminalAutomationService(dependencies({ open }));

    await expect(
      service.handle("terminal_open", {
        workspace: workspaceRoot,
        title: "Dev Server",
      }),
    ).resolves.toMatchObject({
      result: {
        ok: true,
        placement: "background",
        terminal: {
          terminalId: "terminal:20:201",
          title: "Dev Server",
          active: false,
          status: "starting",
        },
      },
    });
    expect(open).toHaveBeenCalledWith(
      { id: workspace.id, root: workspaceRoot },
      "Dev Server",
    );
  });

  it("closes only an idle terminal opened by the same service", async () => {
    let tabs: TerminalTab[] = [terminal()];
    const close = vi.fn((tabId: number, leafId: number) => {
      const target = tabs.find((tab) => tab.id === tabId);
      if (!target || target.activeLeafId !== leafId) return false;
      tabs = tabs.filter((tab) => tab.id !== tabId);
      return true;
    });
    const service = createTerminalAutomationService(
      dependencies({
        getTabs: () => tabs,
        open: (_workspace, title) => {
          tabs.push(
            terminal({
              id: 20,
              title,
              paneTree: { kind: "leaf", id: 201, cwd: workspaceRoot },
              activeLeafId: 201,
            }),
          );
          return { tabId: 20, leafId: 201 };
        },
        close,
      }),
    );

    await service.handle("terminal_open", {
      workspace: workspaceRoot,
      title: "Tests",
    });
    await expect(
      service.handle("terminal_close", {
        workspace: workspaceRoot,
        terminalId: "terminal:20:201",
      }),
    ).resolves.toMatchObject({
      result: { ok: true, closed: true, terminalId: "terminal:20:201" },
    });
    expect(close).toHaveBeenCalledWith(20, 201);
    expect(tabs.map((tab) => tab.id)).toEqual([10]);
  });

  it("retains ownership while an opened tab is still entering React state", async () => {
    let includeOpenedTab = false;
    const openedTab = terminal({
      id: 20,
      title: "Tests",
      paneTree: { kind: "leaf", id: 201, cwd: workspaceRoot },
      activeLeafId: 201,
    });
    const close = vi.fn(() => true);
    const service = createTerminalAutomationService(
      dependencies({
        getTabs: () =>
          includeOpenedTab ? [terminal(), openedTab] : [terminal()],
        open: () => ({ tabId: 20, leafId: 201 }),
        close,
      }),
    );

    await service.handle("terminal_open", {
      workspace: workspaceRoot,
      title: "Tests",
    });
    await expect(
      service.handle("terminal_close", {
        workspace: workspaceRoot,
        terminalId: "terminal:20:201",
      }),
    ).resolves.toMatchObject({ error: { code: "terminal_not_found" } });

    includeOpenedTab = true;
    await expect(
      service.handle("terminal_close", {
        workspace: workspaceRoot,
        terminalId: "terminal:20:201",
      }),
    ).resolves.toMatchObject({ result: { ok: true, closed: true } });
    expect(close).toHaveBeenCalledWith(20, 201);
  });

  it("refuses to close a user-created terminal", async () => {
    const close = vi.fn(() => true);
    const service = createTerminalAutomationService(dependencies({ close }));

    await expect(
      service.handle("terminal_close", {
        workspace: workspaceRoot,
        terminalId: "terminal:10:101",
      }),
    ).resolves.toMatchObject({
      error: { code: "terminal_not_owned" },
    });
    expect(close).not.toHaveBeenCalled();
  });

  it("refuses to close an opened terminal with a foreground process", async () => {
    const openedTab = terminal({
      id: 20,
      title: "Dev Server",
      paneTree: { kind: "leaf", id: 201, cwd: workspaceRoot },
      activeLeafId: 201,
    });
    const close = vi.fn(() => true);
    const service = createTerminalAutomationService(
      dependencies({
        getTabs: () => [terminal(), openedTab],
        open: () => ({ tabId: 20, leafId: 201 }),
        close,
        hasForegroundProcess: async (leafId) => leafId === 201,
      }),
    );

    await service.handle("terminal_open", {
      workspace: workspaceRoot,
      title: "Dev Server",
    });
    await expect(
      service.handle("terminal_close", {
        workspace: workspaceRoot,
        terminalId: "terminal:20:201",
      }),
    ).resolves.toMatchObject({ error: { code: "terminal_busy" } });
    expect(close).not.toHaveBeenCalled();
  });

  it("rejects multiline and control input", () => {
    expect(sanitizeTerminalInput("pnpm test")).toEqual({
      ok: true,
      text: "pnpm test",
    });
    expect(sanitizeTerminalInput("one\ntwo")).toMatchObject({ ok: false });
    expect(sanitizeTerminalInput("bad\u0007")).toMatchObject({ ok: false });
  });

  it("inserts without Enter and executes with Enter in the selected leaf", async () => {
    const writes: Array<[number, string]> = [];
    let buffer = "PS C:\\work\\alpha> ";
    const service = createTerminalAutomationService(
      dependencies({
        getBuffer: () => buffer,
        write: (leafId, data) => {
          writes.push([leafId, data]);
          buffer += data;
          return true;
        },
      }),
    );

    await expect(
      service.handle("terminal_insert", {
        workspace: workspace.root,
        terminalId: "terminal:10:101",
        text: "git status",
      }),
    ).resolves.toMatchObject({
      result: {
        ok: true,
        executed: false,
        inputVisible: true,
        cursor: expect.stringMatching(/^t1:/),
      },
    });
    expect(writes).toEqual([[101, "git status"]]);

    writes.length = 0;
    await expect(
      service.handle("terminal_execute", {
        workspace: workspace.root,
        terminalId: "terminal:10:101",
        text: "pnpm test",
      }),
    ).resolves.toMatchObject({ result: { ok: true, executed: true } });
    await vi.waitFor(() => {
      expect(writes).toEqual([[101, "pnpm test\r"]]);
    });
  });

  it("does not write when the shell is busy", async () => {
    const write = vi.fn(() => true);
    const service = createTerminalAutomationService(
      dependencies({
        getSessionState: () => ({
          ready: true,
          shellExited: false,
          commandRunning: true,
          blockMode: "running",
        }),
        write,
      }),
    );
    const result = await service.handle("terminal_execute", {
      workspace: "space-a",
      terminalId: "terminal:10:101",
      text: "echo unsafe",
    });
    expect(result).toMatchObject({ error: { code: "terminal_busy" } });
    expect(write).not.toHaveBeenCalled();
  });

  it("reserves a terminal immediately while command state catches up", async () => {
    let generation = 2;
    const write = vi.fn(() => true);
    const service = createTerminalAutomationService(
      dependencies({
        getSessionState: () => ({
          ready: true,
          shellExited: false,
          commandRunning: false,
          blockMode: "prompt",
          commandGeneration: generation,
          lastExitCode: generation > 2 ? 0 : null,
          shell: "pwsh",
          inputPending: false,
        }),
        write,
      }),
    );

    await service.handle("terminal_execute", {
      workspace: workspace.root,
      terminalId: "terminal:10:101",
      text: "slow command",
    });
    await expect(
      service.handle("terminal_insert", {
        workspace: workspace.root,
        terminalId: "terminal:10:101",
        text: "must not concatenate",
      }),
    ).resolves.toMatchObject({ error: { code: "terminal_busy" } });
    expect(write).not.toHaveBeenCalled();

    await vi.waitFor(() => {
      expect(write).toHaveBeenCalledTimes(1);
    });

    generation += 1;
    await expect(
      service.handle("terminal_insert", {
        workspace: workspace.root,
        terminalId: "terminal:10:101",
        text: "safe after completion",
      }),
    ).resolves.toMatchObject({ result: { ok: true, executed: false } });
    expect(write).toHaveBeenCalledTimes(2);
  });

  it("returns a polling cursor when inserted input is not visibly echoed", async () => {
    const service = createTerminalAutomationService(
      dependencies({
        getBuffer: () => "PS C:\\work\\alpha> ",
        write: () => true,
      }),
    );

    await expect(
      service.handle("terminal_insert", {
        workspace: workspace.root,
        terminalId: "terminal:10:101",
        text: "git status",
      }),
    ).resolves.toMatchObject({
      result: {
        inputVisible: false,
        cursor: expect.stringMatching(/^t1:/),
      },
    });
  });

  it("cancels a queued execution before any command is dispatched", async () => {
    const write = vi.fn(() => true);
    const service = createTerminalAutomationService(dependencies({ write }));
    const executed = await service.handle("terminal_execute", {
      workspace: workspace.root,
      terminalId: "terminal:10:101",
      text: "must not run",
    });
    const executionId = (executed.result as { executionId: string })
      .executionId;

    await expect(
      service.handle("terminal_interrupt", {
        workspace: workspace.root,
        terminalId: "terminal:10:101",
        executionId,
      }),
    ).resolves.toMatchObject({
      result: {
        phase: "interrupted",
        completionReason: "interrupted",
        cancelledBeforeDispatch: true,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(write).not.toHaveBeenCalled();
    await expect(
      service.handle("terminal_wait", {
        workspace: workspace.root,
        terminalId: "terminal:10:101",
        executionId,
        timeout: 100,
      }),
    ).resolves.toMatchObject({
      result: {
        completed: true,
        phase: "interrupted",
        completionReason: "interrupted",
        interrupted: true,
        exitCode: 130,
      },
    });
  });

  it("targets a dispatched execution before shell busy metadata catches up", async () => {
    let generation = 2;
    let completions: Array<{ generation: number; exitCode: number | null }> =
      [];
    const write = vi.fn((_leafId: number, data: string) => {
      if (data === "\x03") {
        generation = 3;
        completions = [{ generation: 3, exitCode: 1 }];
      }
      return true;
    });
    const service = createTerminalAutomationService(
      dependencies({
        getSessionState: () => ({
          ready: true,
          shellExited: false,
          commandRunning: false,
          blockMode: "prompt",
          commandGeneration: generation,
          lastExitCode: completions[completions.length - 1]?.exitCode ?? null,
          commandCompletions: completions,
          shell: "pwsh",
          inputPending: false,
        }),
        write,
      }),
    );
    const executed = await service.handle("terminal_execute", {
      workspace: workspace.root,
      terminalId: "terminal:10:101",
      text: "slow command",
    });
    const executionId = (executed.result as { executionId: string })
      .executionId;
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));

    await expect(
      service.handle("terminal_interrupt", {
        workspace: workspace.root,
        terminalId: "terminal:10:101",
        executionId,
      }),
    ).resolves.toMatchObject({
      result: { interruptRequested: true, interrupted: true },
    });
    expect(write).toHaveBeenLastCalledWith(101, "\x03");
    await expect(
      service.handle("terminal_wait", {
        workspace: workspace.root,
        terminalId: "terminal:10:101",
        executionId,
        timeout: 1_000,
      }),
    ).resolves.toMatchObject({
      result: {
        phase: "interrupted",
        completionReason: "interrupted",
        exitCode: 130,
      },
    });
  });

  it("does not send Ctrl+C after the targeted execution already completed", async () => {
    let generation = 2;
    let completions: Array<{ generation: number; exitCode: number | null }> =
      [];
    const write = vi.fn((_leafId: number, data: string) => {
      if (data.endsWith("\r")) {
        generation = 3;
        completions = [{ generation: 3, exitCode: 0 }];
      }
      return true;
    });
    const service = createTerminalAutomationService(
      dependencies({
        getSessionState: () => ({
          ready: true,
          shellExited: false,
          commandRunning: false,
          blockMode: "prompt",
          commandGeneration: generation,
          commandCompletions: completions,
          shell: "pwsh",
          inputPending: false,
        }),
        write,
      }),
    );
    const executed = await service.handle("terminal_execute", {
      workspace: workspace.root,
      terminalId: "terminal:10:101",
      text: "fast command",
    });
    const executionId = (executed.result as { executionId: string })
      .executionId;
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));

    await expect(
      service.handle("terminal_interrupt", {
        workspace: workspace.root,
        terminalId: "terminal:10:101",
        executionId,
      }),
    ).resolves.toMatchObject({
      result: {
        alreadyCompleted: true,
        completionReason: "exited",
        interrupted: false,
      },
    });
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("rejects execute when the prompt already contains unsubmitted input", async () => {
    let inputPending = false;
    const write = vi.fn((_leafId: number, data: string) => {
      if (!data.includes("\r")) inputPending = true;
      return true;
    });
    const service = createTerminalAutomationService(
      dependencies({
        getSessionState: () => ({
          ready: true,
          shellExited: false,
          commandRunning: false,
          blockMode: "prompt",
          commandGeneration: 0,
          lastExitCode: null,
          shell: "pwsh",
          inputPending,
        }),
        write,
      }),
    );

    await service.handle("terminal_insert", {
      workspace: workspace.root,
      terminalId: "terminal:10:101",
      text: "git status",
    });
    await expect(
      service.handle("terminal_execute", {
        workspace: workspace.root,
        terminalId: "terminal:10:101",
        text: "pnpm test",
      }),
    ).resolves.toMatchObject({
      error: { code: "terminal_input_pending" },
    });
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("rechecks foreground ownership after renderer preparation", async () => {
    let generation = 2;
    const hasForegroundProcess = vi.fn(async () => false);
    const service = createTerminalAutomationService(
      dependencies({
        hasForegroundProcess,
        getSessionState: () => ({
          ready: true,
          shellExited: false,
          commandRunning: false,
          blockMode: "prompt",
          commandGeneration: generation,
          lastExitCode: generation > 2 ? 0 : null,
          shell: "pwsh",
          inputPending: false,
        }),
        write: () => {
          setTimeout(() => {
            generation += 1;
          }, 10);
          return true;
        },
      }),
    );
    const executed = await service.handle("terminal_execute", {
      workspace: workspace.root,
      terminalId: "terminal:10:101",
      text: "echo quick",
    });
    const executionId = (executed.result as { executionId: string })
      .executionId;
    await service.handle("terminal_wait", {
      workspace: workspace.root,
      terminalId: "terminal:10:101",
      executionId,
      timeout: 1_000,
    });

    expect(hasForegroundProcess).toHaveBeenCalledTimes(3);
  });

  it("prepares a released renderer before executing so OSC completion stays observable", async () => {
    const prepare = vi.fn(() => false);
    const write = vi.fn(() => true);
    const service = createTerminalAutomationService(
      dependencies({ prepare, write }),
    );

    const executed = await service.handle("terminal_execute", {
      workspace: workspace.root,
      terminalId: "terminal:10:101",
      text: "echo tracked",
    });
    const executionId = (executed.result as { executionId: string })
      .executionId;
    await expect(
      service.handle("terminal_wait", {
        workspace: workspace.root,
        terminalId: "terminal:10:101",
        executionId,
        timeout: 1_000,
      }),
    ).resolves.toMatchObject({
      result: {
        completed: true,
        completionReason: "dispatch_failed",
        exitCode: null,
      },
    });
    expect(prepare).toHaveBeenCalledWith(101);
    expect(write).not.toHaveBeenCalled();
  });

  it("synchronizes the initial OSC prompt before capturing the execution baseline", async () => {
    let generation = 0;
    let completions: Array<{ generation: number; exitCode: number | null }> =
      [];
    const prepare = vi.fn(() => {
      setTimeout(() => {
        generation = 1;
        completions = [{ generation: 1, exitCode: 0 }];
      }, 10);
      return true;
    });
    const write = vi.fn(() => {
      expect(generation).toBe(1);
      setTimeout(() => {
        generation = 2;
        completions = [
          { generation: 1, exitCode: 0 },
          { generation: 2, exitCode: 7 },
        ];
      }, 10);
      return true;
    });
    const service = createTerminalAutomationService(
      dependencies({
        prepare,
        write,
        getSessionState: () => ({
          ready: true,
          shellExited: false,
          commandRunning: false,
          blockMode: "prompt",
          commandGeneration: generation,
          commandCompletions: completions,
          lastExitCode: completions[completions.length - 1]?.exitCode ?? null,
          shell: "powershell",
          inputPending: false,
        }),
      }),
    );

    const executed = await service.handle("terminal_execute", {
      workspace: workspace.root,
      terminalId: "terminal:10:101",
      text: "cmd /c exit 7",
    });
    const executionId = (executed.result as { executionId: string })
      .executionId;

    await expect(
      service.handle("terminal_wait", {
        workspace: workspace.root,
        terminalId: "terminal:10:101",
        executionId,
        timeout: 1_000,
      }),
    ).resolves.toMatchObject({
      result: {
        completed: true,
        completionReason: "exited",
        exitCode: 7,
      },
    });
    expect(prepare).toHaveBeenCalledWith(101);
    expect(write).toHaveBeenCalledWith(101, "cmd /c exit 7\r");
  });

  it("fails safely when the initial OSC marker never arrives", async () => {
    const write = vi.fn(() => true);
    const service = createTerminalAutomationService(
      dependencies({
        initialPromptSyncTimeoutMs: 20,
        write,
        getSessionState: () => ({
          ready: true,
          shellExited: false,
          commandRunning: false,
          blockMode: "prompt",
          commandGeneration: 0,
          commandCompletions: [],
          lastExitCode: null,
          shell: "powershell",
          inputPending: false,
        }),
      }),
    );

    const executed = await service.handle("terminal_execute", {
      workspace: workspace.root,
      terminalId: "terminal:10:101",
      text: "cmd /c exit 23",
    });
    const executionId = (executed.result as { executionId: string })
      .executionId;

    await expect(
      service.handle("terminal_wait", {
        workspace: workspace.root,
        terminalId: "terminal:10:101",
        executionId,
        timeout: 1_000,
      }),
    ).resolves.toMatchObject({
      result: {
        completed: true,
        completionReason: "dispatch_failed",
        exitCode: null,
      },
    });
    expect(write).not.toHaveBeenCalled();
  });

  it("returns bounded redacted incremental output", async () => {
    let buffer = "ready API_KEY=supersecretvalue";
    const service = createTerminalAutomationService(
      dependencies({ getBuffer: () => buffer }),
    );
    const first = await service.handle("terminal_read", {
      workspace: "space-a",
      terminalId: "terminal:10:101",
      maxChars: 4_000,
    });
    expect(first).toMatchObject({
      result: {
        output: expect.stringContaining("API_KEY=<REDACTED>"),
        truncated: false,
        hasMore: false,
        historyTruncated: false,
      },
    });
    const cursor = (first.result as { cursor: string }).cursor;
    buffer += "\nnext";
    const second = await service.handle("terminal_read", {
      workspace: "space-a",
      terminalId: "terminal:10:101",
      cursor,
    });
    expect(second).toMatchObject({
      result: { output: "\nnext", reset: false },
    });
  });

  it("waits for the matching completion generation and returns exit code and output", async () => {
    let buffer = "PS C:\\work\\alpha>";
    let generation = 2;
    let running = false;
    const service = createTerminalAutomationService(
      dependencies({
        getBuffer: () => buffer,
        getSessionState: () => ({
          ready: true,
          shellExited: false,
          commandRunning: running,
          blockMode: running ? "running" : "prompt",
          commandGeneration: generation,
          lastExitCode: generation > 2 ? 0 : null,
          commandCompletions:
            generation > 2
              ? [
                  { generation: 3, exitCode: 7 },
                  { generation: 4, exitCode: 0 },
                ]
              : [],
          shell: "pwsh",
        }),
        write: () => {
          running = true;
          setTimeout(() => {
            buffer += "\ncommand output\nPS C:\\work\\alpha>";
            running = false;
            generation += 2;
          }, 10);
          return true;
        },
      }),
    );
    const executed = await service.handle("terminal_execute", {
      workspace: workspace.root,
      terminalId: "terminal:10:101",
      text: "exit 7",
    });
    const executionId = (executed.result as { executionId: string })
      .executionId;
    const waited = await service.handle("terminal_wait", {
      workspace: workspace.root,
      terminalId: "terminal:10:101",
      executionId,
      timeout: 2_000,
    });

    expect(waited).toMatchObject({
      result: {
        completed: true,
        timedOut: false,
        phase: "completed",
        completionReason: "exited",
        interrupted: false,
        exitCode: 7,
        output: expect.stringContaining("command output"),
      },
    });
    const firstOutput = (waited.result as { output: string }).output;
    buffer += "\nlater command output";

    await expect(
      service.handle("terminal_wait", {
        workspace: workspace.root,
        terminalId: "terminal:10:101",
        executionId,
        timeout: 100,
      }),
    ).resolves.toMatchObject({
      result: {
        completed: true,
        repeated: true,
        exitCode: 7,
        output: firstOutput,
      },
    });
  });

  it("retries a repainted buffer before returning fast command output", async () => {
    const prompt = "PS C:\\work\\alpha> ";
    const command = "Write-Output resize-safe";
    let buffer = prompt;
    let generation = 2;
    const service = createTerminalAutomationService(
      dependencies({
        getBuffer: () => buffer,
        getSessionState: () => ({
          ready: true,
          shellExited: false,
          commandRunning: false,
          blockMode: "prompt",
          commandGeneration: generation,
          lastExitCode: generation > 2 ? 0 : null,
          shell: "pwsh",
          inputPending: false,
        }),
        write: () => {
          setTimeout(() => {
            generation += 1;
            buffer = prompt;
            setTimeout(() => {
              buffer = `${prompt}${command}\nresize-safe\n${prompt}`;
            }, 25);
          }, 10);
          return true;
        },
      }),
    );
    const executed = await service.handle("terminal_execute", {
      workspace: workspace.root,
      terminalId: "terminal:10:101",
      text: command,
    });
    const executionId = (executed.result as { executionId: string })
      .executionId;

    await expect(
      service.handle("terminal_wait", {
        workspace: workspace.root,
        terminalId: "terminal:10:101",
        executionId,
        timeout: 2_000,
      }),
    ).resolves.toMatchObject({
      result: {
        completed: true,
        output: expect.stringContaining("resize-safe"),
      },
    });
  });

  it("returns a normal timeout and keeps the execution available for polling", async () => {
    const service = createTerminalAutomationService(dependencies());
    const executed = await service.handle("terminal_execute", {
      workspace: workspace.root,
      terminalId: "terminal:10:101",
      text: "long command",
    });
    const executionId = (executed.result as { executionId: string })
      .executionId;

    await expect(
      service.handle("terminal_wait", {
        workspace: workspace.root,
        terminalId: "terminal:10:101",
        executionId,
        timeout: 100,
      }),
    ).resolves.toMatchObject({
      result: { completed: false, timedOut: true, exitCode: null },
    });
  });

  it("records a closed shell as the execution completion reason", async () => {
    let live = true;
    const service = createTerminalAutomationService(
      dependencies({
        getSessionState: () =>
          live
            ? {
                ready: true,
                shellExited: false,
                commandRunning: false,
                blockMode: "prompt",
                commandGeneration: 2,
                commandCompletions: [],
                shell: "pwsh",
                inputPending: false,
              }
            : null,
        write: () => {
          live = false;
          return true;
        },
      }),
    );
    const executed = await service.handle("terminal_execute", {
      workspace: workspace.root,
      terminalId: "terminal:10:101",
      text: "exit",
    });
    const executionId = (executed.result as { executionId: string })
      .executionId;

    await expect(
      service.handle("terminal_wait", {
        workspace: workspace.root,
        terminalId: "terminal:10:101",
        executionId,
        timeout: 1_000,
      }),
    ).resolves.toMatchObject({
      result: {
        completed: true,
        phase: "completed",
        completionReason: "closed",
        interrupted: false,
        exitCode: null,
      },
    });
  });

  it("falls back to bounded output observation for a shell without OSC markers", async () => {
    let buffer = "C:\\work\\alpha>";
    const service = createTerminalAutomationService(
      dependencies({
        getBuffer: () => buffer,
        getSessionState: () => ({
          ready: true,
          shellExited: false,
          commandRunning: false,
          blockMode: "prompt",
          commandGeneration: 0,
          lastExitCode: 99,
          shell: "cmd",
        }),
        write: () => {
          setTimeout(() => {
            buffer += "\nfast output\nC:\\work\\alpha>";
          }, 10);
          return true;
        },
      }),
    );
    const executed = await service.handle("terminal_execute", {
      workspace: workspace.root,
      terminalId: "terminal:10:101",
      text: "echo fast output",
    });
    const executionId = (executed.result as { executionId: string })
      .executionId;

    await expect(
      service.handle("terminal_wait", {
        workspace: workspace.root,
        terminalId: "terminal:10:101",
        executionId,
        timeout: 2_000,
      }),
    ).resolves.toMatchObject({
      result: {
        completed: true,
        timedOut: false,
        exitCode: null,
        output: expect.stringContaining("fast output"),
      },
    });
  });

  it("interrupts only a busy shared terminal", async () => {
    const write = vi.fn(() => true);
    const service = createTerminalAutomationService(
      dependencies({
        getSessionState: () => ({
          ready: true,
          shellExited: false,
          commandRunning: true,
          blockMode: "running",
        }),
        write,
      }),
    );

    await expect(
      service.handle("terminal_interrupt", {
        workspace: workspace.root,
        terminalId: "terminal:10:101",
      }),
    ).resolves.toMatchObject({
      result: { interrupted: true, clearedInput: false },
    });
    expect(write).toHaveBeenCalledWith(101, "\x03");
  });

  it("uses interrupt to safely clear pending prompt input", async () => {
    const write = vi.fn(() => true);
    const hasForegroundProcess = vi.fn(async () => false);
    const service = createTerminalAutomationService(
      dependencies({
        getSessionState: () => ({
          ready: true,
          shellExited: false,
          commandRunning: false,
          blockMode: "prompt",
          inputPending: true,
        }),
        hasForegroundProcess,
        write,
      }),
    );

    await expect(
      service.handle("terminal_interrupt", {
        workspace: workspace.root,
        terminalId: "terminal:10:101",
      }),
    ).resolves.toMatchObject({
      result: { interrupted: false, clearedInput: true },
    });
    expect(write).toHaveBeenCalledWith(101, "\x03");
    expect(hasForegroundProcess).not.toHaveBeenCalled();
  });
});
