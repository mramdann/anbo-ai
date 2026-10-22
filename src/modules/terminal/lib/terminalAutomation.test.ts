import type { SpaceMeta } from "@/modules/spaces/lib/store";
import type { TerminalTab } from "@/modules/tabs";
import { describe, expect, it, vi } from "vitest";
import {
  batchJobQuestion,
  clipExecutionOutput,
  collectSharedTerminals,
  continuationPrompt,
  pagerOnScreen,
  createTerminalAutomationService,
  sanitizeTerminalInput,
  sanitizeTerminalTitle,
  type TerminalAutomationDependencies,
} from "./terminalAutomation";
import type { TerminalSessionState } from "./useTerminalSession";

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
    unpreparedReason: () => "unprepared",
    open: () => ({ tabId: 20, leafId: 201 }),
    close: () => true,
    write: () => true,
    ...overrides,
  };
}

// A Windows PowerShell whose first prompt has not ended yet.
function startingShell(
  overrides: Partial<TerminalSessionState> = {},
): TerminalSessionState {
  return {
    ready: true,
    shellExited: false,
    commandRunning: false,
    blockMode: "prompt",
    commandGeneration: 0,
    commandCompletions: [],
    lastExitCode: null,
    shell: "powershell",
    inputPending: false,
    awaitingFirstPrompt: true,
    ...overrides,
  };
}

describe("shared terminal discovery", () => {
  it("reports the selected first terminal returned by the workspace opener", async () => {
    const service = createTerminalAutomationService(
      dependencies({
        open: () => ({ tabId: 20, leafId: 201, activated: true }),
      }),
    );
    await expect(
      service.handle("terminal_open", {
        workspace: workspaceRoot,
        title: "First terminal",
      }),
    ).resolves.toMatchObject({
      result: {
        placement: "visible-first-tab",
        terminal: { tabId: 20, active: true },
      },
    });
  });
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

  it("reports a shell as starting until its first prompt ends", async () => {
    const hasForegroundProcess = vi.fn(async () => false);
    const list = (state: TerminalSessionState) =>
      collectSharedTerminals(
        dependencies({ getSessionState: () => state, hasForegroundProcess }),
        { id: workspace.id, root: workspaceRoot },
      );

    expect((await list(startingShell()))[0].status).toBe("starting");
    expect(hasForegroundProcess).not.toHaveBeenCalled();
    expect(
      (await list(startingShell({ awaitingFirstPrompt: false })))[0].status,
    ).toBe("idle");
    // cmd marks no prompt, so there is no first one to wait for.
    expect((await list(startingShell({ shell: "cmd" })))[0].status).toBe(
      "idle",
    );
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

  it("closes an opened terminal once an agent CLI run in it has ended", async () => {
    // `kimi --version` made the tab an agent tab, and the CLI is gone again.
    const adoptedTab = terminal({
      id: 20,
      title: "Kimi",
      agent: { launcherId: "kimi", icon: "kimi", label: "Kimi", name: "Kimi" },
      paneTree: { kind: "leaf", id: 201, cwd: workspaceRoot },
      activeLeafId: 201,
    });
    const close = vi.fn(() => true);
    const service = createTerminalAutomationService(
      dependencies({
        getTabs: () => [terminal(), adoptedTab],
        open: () => ({ tabId: 20, leafId: 201 }),
        close,
      }),
    );

    await service.handle("terminal_open", {
      workspace: workspaceRoot,
      title: "Probe",
    });
    // It stays its opener's terminal for every tool. Measured: an agent's
    // 'git' terminal left terminal_list after a CLI ran in it, and the agent
    // made another while the first stayed open.
    const listed = await service.handle("terminal_list", {
      workspace: workspaceRoot,
    });
    expect(
      (listed.result as { terminals: { terminalId: string }[] }).terminals.map(
        (entry) => entry.terminalId,
      ),
    ).toEqual(["terminal:10:101", "terminal:20:201"]);
    await expect(
      service.handle("terminal_read", {
        workspace: workspaceRoot,
        terminalId: "terminal:20:201",
      }),
    ).resolves.toMatchObject({
      result: { terminal: { terminalId: "terminal:20:201", status: "idle" } },
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
  });

  it("refuses an opened terminal while an agent CLI runs in it", async () => {
    const adoptedTab = terminal({
      id: 20,
      title: "Kimi",
      agent: { launcherId: "kimi", icon: "kimi", label: "Kimi", name: "Kimi" },
      paneTree: { kind: "leaf", id: 201, cwd: workspaceRoot },
      activeLeafId: 201,
    });
    const close = vi.fn(() => true);
    const service = createTerminalAutomationService(
      dependencies({
        getTabs: () => [terminal(), adoptedTab],
        getSessions: () => ({
          201: {
            leafId: 201,
            tabId: 20,
            agent: "kimi",
            name: "Kimi",
            status: "waiting",
            phase: "finished",
            startedAt: 1,
            lastActivityAt: 1,
            attentionSince: null,
          },
        }),
        open: () => ({ tabId: 20, leafId: 201 }),
        close,
      }),
    );

    await service.handle("terminal_open", {
      workspace: workspaceRoot,
      title: "Probe",
    });
    await expect(
      service.handle("terminal_close", {
        workspace: workspaceRoot,
        terminalId: "terminal:20:201",
      }),
    ).resolves.toMatchObject({
      error: {
        code: "terminal_busy",
        message: expect.stringContaining("agent CLI"),
      },
    });
    expect(close).not.toHaveBeenCalled();
  });

  it("refuses an agent tab that terminal_open did not make", async () => {
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
    const close = vi.fn(() => true);
    const service = createTerminalAutomationService(
      dependencies({ getTabs: () => [terminal(), agentTab], close }),
    );

    await expect(
      service.handle("terminal_close", {
        workspace: workspaceRoot,
        terminalId: "terminal:12:121",
      }),
    ).resolves.toMatchObject({ error: { code: "terminal_not_found" } });
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

  it("writes nothing once the caller has stopped waiting", async () => {
    const write = vi.fn(() => true);
    const service = createTerminalAutomationService(dependencies({ write }));
    const late = Date.now() - 1;
    for (const method of ["terminal_insert", "terminal_execute"] as const) {
      await expect(
        service.handle(
          method,
          {
            workspace: workspace.root,
            terminalId: "terminal:10:101",
            text: "pnpm test",
          },
          late,
        ),
      ).resolves.toMatchObject({
        error: {
          code: "timeout",
          message: expect.stringContaining("nothing was done"),
        },
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(write).not.toHaveBeenCalled();
    // Still in time: the command goes out as usual.
    await expect(
      service.handle(
        "terminal_execute",
        {
          workspace: workspace.root,
          terminalId: "terminal:10:101",
          text: "pnpm test",
        },
        Date.now() + 5_000,
      ),
    ).resolves.toMatchObject({ result: { ok: true, executed: true } });
    await vi.waitFor(() =>
      expect(write).toHaveBeenCalledWith(101, "pnpm test\r"),
    );
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
        interruptRequested: true,
        cancelledBeforeDispatch: true,
        exitCode: null,
      },
    });
  });

  it("targets a dispatched execution before shell busy metadata catches up", async () => {
    let generation = 2;
    let completions: Array<{
      generation: number;
      exitCode: number | null;
      at?: number;
    }> = [];
    const write = vi.fn((_leafId: number, data: string) => {
      if (data === "\x03") {
        generation = 3;
        completions = [{ generation: 3, exitCode: 1, at: Date.now() }];
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
        interruptRequested: true,
        endedAfterInterruptMs: expect.any(Number),
        // The shell's own code, as PowerShell reports a stopped cmdlet.
        exitCode: 1,
      },
    });
  });

  it("reports a command that ran on after the Ctrl+C as exited, with its shell's exit code", async () => {
    let generation = 2;
    let completions: Array<{
      generation: number;
      exitCode: number | null;
      at?: number;
    }> = [];
    const write = vi.fn((_leafId: number, data: string) => {
      // The program catches the Ctrl+C and fails on its own 5 s later.
      if (data === "\x03") {
        generation = 3;
        completions = [{ generation: 3, exitCode: 3, at: Date.now() + 5_000 }];
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
      text: "node catches-ctrl-c.js",
    });
    const executionId = (executed.result as { executionId: string })
      .executionId;
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    await service.handle("terminal_interrupt", {
      workspace: workspace.root,
      terminalId: "terminal:10:101",
      executionId,
    });

    const waited = await service.handle("terminal_wait", {
      workspace: workspace.root,
      terminalId: "terminal:10:101",
      executionId,
      timeout: 1_000,
    });
    expect(waited).toMatchObject({
      result: {
        completed: true,
        phase: "completed",
        completionReason: "exited",
        interrupted: false,
        interruptRequested: true,
        exitCode: 3,
        note: expect.stringContaining("it ran on or took that long to stop"),
      },
    });
    expect(
      (waited.result as { endedAfterInterruptMs: number })
        .endedAfterInterruptMs,
    ).toBeGreaterThanOrEqual(4_900);
  });

  it("answers cmd's batch question after its own Ctrl+C", async () => {
    let buffer = "PS C:\\work\\alpha> ";
    let running = false;
    let generation = 2;
    let completions: Array<{
      generation: number;
      exitCode: number | null;
      at?: number;
    }> = [];
    const write = vi.fn((_leafId: number, data: string) => {
      if (data === "\x03") {
        // cmd stops the batch's program, then asks.
        setTimeout(() => {
          buffer += "^CTerminate batch job (Y/N)? ";
        }, 30);
      } else if (data === "Y\r") {
        buffer += "Y\nPS C:\\work\\alpha> ";
        running = false;
        generation = 3;
        completions = [{ generation: 3, exitCode: 255, at: Date.now() }];
      } else {
        running = true;
        buffer += ".\\build.cmd\nstep 1 of 2\n";
      }
      return true;
    });
    const service = createTerminalAutomationService(
      dependencies({
        getBuffer: () => buffer,
        getSessionState: () => ({
          ready: true,
          shellExited: false,
          commandRunning: running,
          blockMode: running ? "running" : "prompt",
          commandGeneration: generation,
          commandCompletions: completions,
          shell: "powershell",
          inputPending: false,
        }),
        write,
      }),
    );
    const executed = await service.handle("terminal_execute", {
      workspace: workspace.root,
      terminalId: "terminal:10:101",
      text: ".\\build.cmd",
    });
    const executionId = (executed.result as { executionId: string })
      .executionId;
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    await service.handle("terminal_interrupt", {
      workspace: workspace.root,
      terminalId: "terminal:10:101",
      executionId,
    });
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(3));

    expect(write.mock.calls.map(([, data]) => data)).toEqual([
      ".\\build.cmd\r",
      "\x03",
      "Y\r",
    ]);
    await expect(
      service.handle("terminal_wait", {
        workspace: workspace.root,
        terminalId: "terminal:10:101",
        executionId,
        timeout: 1_000,
      }),
    ).resolves.toMatchObject({
      result: {
        completionReason: "interrupted",
        answeredBatchQuestion: true,
        exitCode: 255,
      },
    });
  });

  it("answers a batch question already on screen instead of sending a Ctrl+C that means no", async () => {
    const write = vi.fn(() => true);
    const service = createTerminalAutomationService(
      dependencies({
        getBuffer: () => "step 1 of 2\r\n^CTerminate batch job (Y/N)? ",
        getSessionState: () => ({
          ready: true,
          shellExited: false,
          commandRunning: true,
          blockMode: "running",
          shell: "powershell",
        }),
        write,
      }),
    );

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(
        service.handle("terminal_interrupt", {
          workspace: workspace.root,
          terminalId: "terminal:10:101",
        }),
      ).resolves.toMatchObject({
        result: { interrupted: true, answeredBatchQuestion: true },
      });
    }
    // The second call finds the answer still echoing, and adds nothing.
    expect(write.mock.calls).toEqual([[101, "Y\r"]]);
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
    const unpreparedReason = vi.fn(
      () => "All 16 live terminal buffers are in use, so nothing was sent.",
    );
    const write = vi.fn(() => true);
    const service = createTerminalAutomationService(
      dependencies({ prepare, unpreparedReason, write }),
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
        dispatchError:
          "All 16 live terminal buffers are in use, so nothing was sent.",
        exitCode: null,
      },
    });
    // An agent that asks again later still learns why.
    await expect(
      service.handle("terminal_interrupt", {
        workspace: workspace.root,
        terminalId: "terminal:10:101",
        executionId,
      }),
    ).resolves.toMatchObject({
      result: {
        alreadyCompleted: true,
        completionReason: "dispatch_failed",
        dispatchError:
          "All 16 live terminal buffers are in use, so nothing was sent.",
      },
    });
    expect(prepare).toHaveBeenCalledWith(101);
    expect(unpreparedReason).toHaveBeenCalledWith(101);
    expect(write).not.toHaveBeenCalled();
  });

  it("says why a command was held back when the prompt changed before dispatch", async () => {
    let state = {
      ready: true,
      shellExited: false,
      commandRunning: false,
      blockMode: "prompt" as const,
      commandGeneration: 2,
      lastExitCode: 0,
      shell: "pwsh",
      inputPending: false,
    };
    const write = vi.fn(() => true);
    const service = createTerminalAutomationService(
      dependencies({ getSessionState: () => state, write }),
    );
    const executed = await service.handle("terminal_execute", {
      workspace: workspace.root,
      terminalId: "terminal:10:101",
      text: "echo late",
    });
    // The user typed at the prompt before the queued command went out.
    state = { ...state, inputPending: true };
    await expect(
      service.handle("terminal_wait", {
        workspace: workspace.root,
        terminalId: "terminal:10:101",
        executionId: (executed.result as { executionId: string }).executionId,
        timeout: 1_000,
      }),
    ).resolves.toMatchObject({
      result: {
        completionReason: "dispatch_failed",
        dispatchError: expect.stringContaining(
          "The prompt held input nobody had submitted, so nothing was sent.",
        ),
      },
    });
    expect(write).not.toHaveBeenCalled();
  });

  it("names the error when sending a command throws", async () => {
    const service = createTerminalAutomationService(
      dependencies({
        prepare: () => {
          throw new Error("renderer pool is gone");
        },
      }),
    );
    const executed = await service.handle("terminal_execute", {
      workspace: workspace.root,
      terminalId: "terminal:10:101",
      text: "echo thrown",
    });
    await expect(
      service.handle("terminal_wait", {
        workspace: workspace.root,
        terminalId: "terminal:10:101",
        executionId: (executed.result as { executionId: string }).executionId,
        timeout: 1_000,
      }),
    ).resolves.toMatchObject({
      result: {
        completionReason: "dispatch_failed",
        dispatchError: "Sending the command failed: renderer pool is gone",
      },
    });
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
        dispatchError: expect.stringContaining(
          "The shell did not mark its first prompt within 0.02 s, so nothing was sent",
        ),
        exitCode: null,
      },
    });
    expect(write).not.toHaveBeenCalled();
  });

  it("sends a command queued while the shell starts at its first prompt", async () => {
    // Its PTY is still opening.
    let state = startingShell({ ready: false, awaitingFirstPrompt: false });
    const events: string[] = [];
    const prepare = vi.fn(() => {
      events.push(state.awaitingFirstPrompt ? "prepare early" : "prepare");
      return true;
    });
    const write = vi.fn((_leafId: number, data: string) => {
      events.push(`write ${data}`);
      setTimeout(() => {
        state = {
          ...state,
          commandGeneration: 2,
          commandCompletions: [
            { generation: 1, exitCode: 0 },
            { generation: 2, exitCode: 0 },
          ],
        };
      }, 10);
      return true;
    });
    const service = createTerminalAutomationService(
      dependencies({ getSessionState: () => state, prepare, write }),
    );

    const executed = await service.handle("terminal_execute", {
      workspace: workspace.root,
      terminalId: "terminal:10:101",
      text: "echo ready",
    });
    expect(executed).toMatchObject({
      result: { executed: true, phase: "queued" },
    });
    const executionId = (executed.result as { executionId: string })
      .executionId;
    await new Promise((resolve) => setTimeout(resolve, 300));
    state = { ...state, ready: true, awaitingFirstPrompt: true };
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(events).toEqual([]);

    // The first prompt ends the start, and its marks count one completion.
    state = {
      ...state,
      awaitingFirstPrompt: false,
      commandGeneration: 1,
      commandCompletions: [{ generation: 1, exitCode: 0 }],
    };
    await expect(
      service.handle("terminal_wait", {
        workspace: workspace.root,
        terminalId: "terminal:10:101",
        executionId,
        timeout: 1_000,
      }),
    ).resolves.toMatchObject({
      result: { completed: true, completionReason: "exited", exitCode: 0 },
    });
    expect(events).toEqual(["prepare", "write echo ready\r"]);
  });

  it("never sends a command cancelled while the shell starts", async () => {
    let state = startingShell();
    const prepare = vi.fn(() => true);
    const write = vi.fn(() => true);
    const service = createTerminalAutomationService(
      dependencies({ getSessionState: () => state, prepare, write }),
    );
    const executed = await service.handle("terminal_execute", {
      workspace: workspace.root,
      terminalId: "terminal:10:101",
      text: "must not run",
    });
    const executionId = (executed.result as { executionId: string })
      .executionId;
    await new Promise((resolve) => setTimeout(resolve, 300));

    await expect(
      service.handle("terminal_interrupt", {
        workspace: workspace.root,
        terminalId: "terminal:10:101",
        executionId,
      }),
    ).resolves.toMatchObject({ result: { cancelledBeforeDispatch: true } });
    state = { ...state, awaitingFirstPrompt: false, commandGeneration: 1 };
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(prepare).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("never sends a command cancelled while its first prompt mark is parsed", async () => {
    let state = startingShell({ awaitingFirstPrompt: false });
    const prepare = vi.fn(() => true);
    const write = vi.fn(() => true);
    const service = createTerminalAutomationService(
      dependencies({ getSessionState: () => state, prepare, write }),
    );
    const executed = await service.handle("terminal_execute", {
      workspace: workspace.root,
      terminalId: "terminal:10:101",
      text: "must not run",
    });
    const executionId = (executed.result as { executionId: string })
      .executionId;
    await vi.waitFor(() => expect(prepare).toHaveBeenCalled());

    await expect(
      service.handle("terminal_interrupt", {
        workspace: workspace.root,
        terminalId: "terminal:10:101",
        executionId,
      }),
    ).resolves.toMatchObject({ result: { cancelledBeforeDispatch: true } });
    state = {
      ...state,
      commandGeneration: 1,
      commandCompletions: [{ generation: 1, exitCode: 0 }],
    };
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(write).not.toHaveBeenCalled();
  });

  it("gives up on a shell that never ends its first prompt", async () => {
    const prepare = vi.fn(() => true);
    const write = vi.fn(() => true);
    const service = createTerminalAutomationService(
      dependencies({
        initialPromptSyncTimeoutMs: 50,
        getSessionState: () => startingShell(),
        prepare,
        write,
      }),
    );
    const executed = await service.handle("terminal_execute", {
      workspace: workspace.root,
      terminalId: "terminal:10:101",
      text: "echo never",
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
        completionReason: "dispatch_failed",
        dispatchError: expect.stringContaining(
          "The shell did not mark its first prompt within 0.05 s, so nothing was sent",
        ),
      },
    });
    expect(prepare).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("sends a command to a shell that takes most of a minute to its first prompt", async () => {
    // Twenty Windows PowerShells started together took up to 33 s to their
    // first prompt, and 30 s refused some of their commands.
    vi.useFakeTimers();
    try {
      let state = startingShell();
      const write = vi.fn(() => true);
      const service = createTerminalAutomationService(
        dependencies({ getSessionState: () => state, write }),
      );
      await service.handle("terminal_execute", {
        workspace: workspace.root,
        terminalId: "terminal:10:101",
        text: "echo late",
      });
      await vi.advanceTimersByTimeAsync(59_000);
      expect(write).not.toHaveBeenCalled();

      state = {
        ...state,
        awaitingFirstPrompt: false,
        commandGeneration: 1,
        commandCompletions: [{ generation: 1, exitCode: 0 }],
      };
      await vi.advanceTimersByTimeAsync(100);
      expect(write).toHaveBeenCalledWith(101, "echo late\r");
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up on a first prompt a minute after the command came", async () => {
    vi.useFakeTimers();
    try {
      const write = vi.fn(() => true);
      const service = createTerminalAutomationService(
        dependencies({ getSessionState: () => startingShell(), write }),
      );
      const executed = await service.handle("terminal_execute", {
        workspace: workspace.root,
        terminalId: "terminal:10:101",
        text: "echo never",
      });
      const executionId = (executed.result as { executionId: string })
        .executionId;
      await vi.advanceTimersByTimeAsync(60_300);

      const waited = service.handle("terminal_wait", {
        workspace: workspace.root,
        terminalId: "terminal:10:101",
        executionId,
        timeout: 100,
      });
      await vi.advanceTimersByTimeAsync(200);
      await expect(waited).resolves.toMatchObject({
        result: {
          completionReason: "dispatch_failed",
          dispatchError: expect.stringContaining(
            "The shell did not mark its first prompt within 60 s",
          ),
        },
      });
      expect(write).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends nothing when a terminal never gets a session within the first-prompt wait", async () => {
    const write = vi.fn(() => true);
    const service = createTerminalAutomationService(
      dependencies({
        getSessionState: () => null,
        write,
        initialPromptSyncTimeoutMs: 50,
      }),
    );
    const executed = await service.handle("terminal_execute", {
      workspace: workspace.root,
      terminalId: "terminal:10:101",
      text: "echo too early",
    });
    expect(executed).toMatchObject({
      result: { executed: true, phase: "queued" },
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
        completionReason: "dispatch_failed",
        dispatchError: expect.stringContaining("did not start a shell"),
      },
    });
    expect(write).not.toHaveBeenCalled();
  });

  it("refuses to type into a shell that has not ended its first prompt", async () => {
    const write = vi.fn(() => true);
    const service = createTerminalAutomationService(
      dependencies({ getSessionState: () => startingShell(), write }),
    );
    await expect(
      service.handle("terminal_insert", {
        workspace: workspace.root,
        terminalId: "terminal:10:101",
        text: "echo early",
      }),
    ).resolves.toMatchObject({
      error: {
        code: "terminal_busy",
        message: expect.stringContaining("terminal:10:101 is starting"),
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
    expect(waited.result).not.toHaveProperty("dispatchError");
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

  it("sends no Ctrl+C to a shell that has not ended its first prompt", async () => {
    const write = vi.fn(() => true);
    for (const state of [
      startingShell(),
      startingShell({ inputPending: true }),
      startingShell({ ready: false, awaitingFirstPrompt: false }),
    ]) {
      const service = createTerminalAutomationService(
        dependencies({ getSessionState: () => state, write }),
      );
      await expect(
        service.handle("terminal_interrupt", {
          workspace: workspace.root,
          terminalId: "terminal:10:101",
        }),
      ).resolves.toMatchObject({
        error: {
          code: "terminal_busy",
          message: expect.stringContaining(
            "terminal:10:101 is starting, so no Ctrl+C was sent",
          ),
        },
      });
    }
    expect(write).not.toHaveBeenCalled();
  });
});

describe("cmd's batch question", () => {
  it("is found by its shape, in any language, only at the end of the screen", () => {
    expect(batchJobQuestion("step 1\r\n^CTerminate batch job (Y/N)? ")).toBe(
      "Y",
    );
    expect(batchJobQuestion("^CBatchvorgang abbrechen (J/N)?\n\n")).toBe("J");
    expect(
      batchJobQuestion("50%^CTerminer le programme de commandes (O/N) ?"),
    ).toBe("O");
    // A program's own question, one already answered, one the shell left.
    expect(batchJobQuestion("Continue (y/n)?")).toBeNull();
    expect(batchJobQuestion("^CTerminate batch job (Y/N)? Y")).toBeNull();
    expect(
      batchJobQuestion("^CTerminate batch job (Y/N)? Y\nPS C:\\work> "),
    ).toBeNull();
  });
});

describe("terminals that have not started", () => {
  const promptShown = (): TerminalSessionState => ({
    ...startingShell(),
    awaitingFirstPrompt: false,
    commandGeneration: 1,
    commandCompletions: [{ generation: 1, exitCode: 0, at: 1 }],
  });

  it("lists a restored tab never shown as dormant, and an execute starts it", async () => {
    // Measured: a terminal restored at start and never shown read "starting"
    // for 11 hours and execute refused it at once, so an agent's wait for it
    // never ended.
    let state: TerminalSessionState | null = null;
    const warm = vi.fn(() => {
      setTimeout(() => {
        state = startingShell();
      }, 20);
      setTimeout(() => {
        state = promptShown();
      }, 60);
    });
    const write = vi.fn(() => true);
    const service = createTerminalAutomationService(
      dependencies({
        getTabs: () => [terminal({ cold: true })],
        getSessionState: () => state,
        warm,
        write,
      }),
    );
    await expect(
      service.handle("terminal_list", { workspace: workspaceRoot }),
    ).resolves.toMatchObject({
      result: {
        terminals: [{ terminalId: "terminal:10:101", status: "dormant" }],
        note: expect.stringContaining("terminal_execute starts it"),
      },
    });
    await expect(
      service.handle("terminal_execute", {
        workspace: workspaceRoot,
        terminalId: "terminal:10:101",
        text: "echo hi",
      }),
    ).resolves.toMatchObject({ result: { executed: true, phase: "queued" } });
    expect(warm).toHaveBeenCalledWith(10);
    await vi.waitFor(() => {
      expect(write).toHaveBeenCalledWith(101, "echo hi\r");
    });
  });

  it("starts a dormant tab for a read and says to read again", async () => {
    const warm = vi.fn();
    const service = createTerminalAutomationService(
      dependencies({
        getTabs: () => [terminal({ cold: true })],
        getSessionState: () => null,
        getBuffer: () => null,
        warm,
      }),
    );
    await expect(
      service.handle("terminal_read", {
        workspace: workspaceRoot,
        terminalId: "terminal:10:101",
      }),
    ).resolves.toMatchObject({
      error: {
        code: "terminal_unavailable",
        message: expect.stringContaining("Anbo is starting it now"),
      },
    });
    expect(warm).toHaveBeenCalledWith(10);
  });

  it("runs a command sent before a just-opened terminal has a session", async () => {
    // Measured: terminal_execute 260 ms after terminal_open answered "is
    // starting" at once; the agent read the prompt and had to run it again.
    let state: TerminalSessionState | null = null;
    setTimeout(() => {
      state = promptShown();
    }, 50);
    const write = vi.fn(() => true);
    const service = createTerminalAutomationService(
      dependencies({ getSessionState: () => state, write }),
    );
    await expect(
      service.handle("terminal_execute", {
        workspace: workspaceRoot,
        terminalId: "terminal:10:101",
        text: "echo hi",
      }),
    ).resolves.toMatchObject({ result: { executed: true } });
    await vi.waitFor(() => {
      expect(write).toHaveBeenCalledWith(101, "echo hi\r");
    });
  });

  it("names why a shell could not start and starts it again for an execute", async () => {
    // Measured: a shell the resource guard refused read "exited" and execute
    // said to wait for an idle prompt, which never came.
    const refused: TerminalSessionState = {
      ...startingShell(),
      ready: false,
      shellExited: true,
      awaitingFirstPrompt: false,
      spawnFailed: true,
      spawnError: "resource_exhausted: Not enough system memory",
    };
    let state: TerminalSessionState = refused;
    const retryStart = vi.fn(() => {
      state = startingShell();
      setTimeout(() => {
        state = promptShown();
      }, 30);
      return true;
    });
    const write = vi.fn(() => true);
    const service = createTerminalAutomationService(
      dependencies({ getSessionState: () => state, retryStart, write }),
    );
    await expect(
      service.handle("terminal_list", { workspace: workspaceRoot }),
    ).resolves.toMatchObject({ result: { terminals: [{ status: "failed" }] } });
    await expect(
      service.handle("terminal_execute", {
        workspace: workspaceRoot,
        terminalId: "terminal:10:101",
        text: "echo hi",
      }),
    ).resolves.toMatchObject({ result: { executed: true } });
    expect(retryStart).toHaveBeenCalledWith(101);
    await vi.waitFor(() => {
      expect(write).toHaveBeenCalledWith(101, "echo hi\r");
    });

    state = refused;
    const noRetry = createTerminalAutomationService(
      dependencies({ getSessionState: () => state, retryStart: () => false }),
    );
    await expect(
      noRetry.handle("terminal_execute", {
        workspace: workspaceRoot,
        terminalId: "terminal:10:101",
        text: "echo hi",
      }),
    ).resolves.toMatchObject({
      error: {
        code: "terminal_unavailable",
        message: expect.stringContaining(
          "could not start: resource_exhausted: Not enough system memory",
        ),
      },
    });
  });
});

describe("terminal_wait answers and executions that never end", () => {
  const prompt = "PS C:\\work\\alpha> ";

  /** A pwsh session: a command marks it running, `finish` ends it. */
  function shellRig() {
    const rig = {
      buffer: prompt,
      generation: 2,
      running: false,
      completions: [] as { generation: number; exitCode: number; at: number }[],
      state: (): TerminalSessionState => ({
        ready: true,
        shellExited: false,
        commandRunning: rig.running,
        blockMode: rig.running ? "running" : "prompt",
        commandGeneration: rig.generation,
        commandCompletions: rig.completions,
        lastExitCode: 0,
        shell: "pwsh",
        inputPending: false,
      }),
      finish(output: string, exitCode = 0) {
        rig.buffer += `${output}\n${prompt}`;
        rig.running = false;
        rig.generation += 1;
        rig.completions = [
          ...rig.completions,
          { generation: rig.generation, exitCode, at: Date.now() },
        ];
      },
    };
    return rig;
  }

  const target = { workspace: workspaceRoot, terminalId: "terminal:10:101" };
  const idOf = (response: { result?: unknown }) =>
    (response.result as { executionId: string }).executionId;

  it("knows the prompt of a shell waiting for the rest of a command", () => {
    expect(continuationPrompt(`${prompt}Write-Output 'abc\n>> `)).toBe(true);
    expect(continuationPrompt('$ echo "a\n> ')).toBe(true);
    expect(continuationPrompt('% echo "a\ndquote> ')).toBe(true);
    expect(continuationPrompt(prompt)).toBe(false);
    expect(continuationPrompt(`${prompt}echo a >`)).toBe(false);
    expect(continuationPrompt("build done\n")).toBe(false);
  });

  it("cancels a command the shell took as unfinished, and names a held terminal's execution", async () => {
    // Measured: a one-liner with an open quote left PowerShell at ">>"; the
    // execution never ended and every later command read "still observing
    // a previously executed command" while the terminal looked idle.
    vi.useFakeTimers();
    try {
      const rig = shellRig();
      const write = vi.fn((_leafId: number, data: string) => {
        if (data === "Write-Output 'abc\r") {
          rig.buffer += "Write-Output 'abc\n>> ";
        }
        if (data === "\x03") rig.buffer += `\n${prompt}`;
        return true;
      });
      const service = createTerminalAutomationService(
        dependencies({
          getBuffer: () => rig.buffer,
          getSessionState: rig.state,
          write,
        }),
      );
      const executionId = idOf(
        await service.handle("terminal_execute", {
          ...target,
          text: "Write-Output 'abc",
        }),
      );
      await vi.advanceTimersByTimeAsync(300);
      expect(write).toHaveBeenCalledWith(101, "Write-Output 'abc\r");
      await expect(
        service.handle("terminal_execute", { ...target, text: "echo next" }),
      ).resolves.toMatchObject({
        error: {
          code: "terminal_busy",
          message: expect.stringContaining(
            `is still running ${executionId}, sent 0 s ago; wait for it with terminal_wait`,
          ),
        },
      });

      const waited = service.handle("terminal_wait", {
        ...target,
        executionId,
        timeout: 5_000,
      });
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(waited).resolves.toMatchObject({
        result: {
          completed: true,
          completionReason: "dispatch_failed",
          dispatchError: expect.stringContaining(
            "read the command as unfinished",
          ),
        },
      });
      expect(write).toHaveBeenCalledWith(101, "\x03");
      await expect(
        service.handle("terminal_execute", { ...target, text: "echo next" }),
      ).resolves.toMatchObject({ result: { executed: true } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("cuts each wait's answer from the whole output, keeping its start and its end", async () => {
    // Measured: a second wait with maxChars 12000 gave the first wait's cut
    // again, and a wait on a long job showed its first lines every time.
    const rig = shellRig();
    const lines = Array.from(
      { length: 400 },
      (_, index) => `line ${index + 1}`,
    ).join("\n");
    const service = createTerminalAutomationService(
      dependencies({
        getBuffer: () => rig.buffer,
        getSessionState: rig.state,
        write: (_leafId, data) => {
          if (data === "node job.js\r") {
            rig.buffer += "node job.js\n";
            rig.running = true;
            setTimeout(() => rig.finish(lines), 20);
          }
          return true;
        },
      }),
    );
    const executionId = idOf(
      await service.handle("terminal_execute", {
        ...target,
        text: "node job.js",
      }),
    );
    const small = await service.handle("terminal_wait", {
      ...target,
      executionId,
      timeout: 2_000,
      maxChars: 1_000,
    });
    const cut = small.result as {
      output: string;
      omittedCursor: string;
      omittedChars: number;
    };
    expect(small.result).toMatchObject({
      completed: true,
      truncated: true,
      hasMore: false,
    });
    expect(cut.output.length).toBeLessThanOrEqual(1_000);
    expect(cut.output.startsWith("node job.js\nline 1\n")).toBe(true);
    expect(cut.output).toContain(`${cut.omittedChars} characters left out`);
    expect(cut.output.endsWith(`line 400\n${prompt}`)).toBe(true);

    const large = await service.handle("terminal_wait", {
      ...target,
      executionId,
      timeout: 100,
      maxChars: 12_000,
    });
    expect(large.result).toMatchObject({
      completed: true,
      repeated: true,
      truncated: false,
    });
    expect((large.result as { output: string }).output).toContain(
      "\nline 200\n",
    );
    await expect(
      service.handle("terminal_wait", {
        ...target,
        executionId,
        timeout: 100,
        maxChars: 1_000,
      }),
    ).resolves.toMatchObject({ result: { output: cut.output } });

    const omitted = await service.handle("terminal_read", {
      ...target,
      cursor: cut.omittedCursor,
      maxChars: 200,
    });
    expect(omitted).toMatchObject({ result: { reset: false } });
    expect((omitted.result as { output: string }).output).toMatch(
      /^line \d+\n/,
    );
  });

  it("finds a repainted command's output by its own text", async () => {
    // Measured: after a repaint a wait's output began with the terminal's old
    // history and was cut before this run's result.
    for (const [repaint, replayed, start] of [
      [
        `older screen\n${prompt}Get-Date\nTuesday 21 October\n${prompt}`,
        false,
        "Get-Date\nTuesday",
      ],
      [`Tuesday 21 October\n${prompt}`, true, "Tuesday"],
    ] as const) {
      const rig = shellRig();
      rig.buffer = `${prompt}dir\nold output\n${prompt}`;
      const service = createTerminalAutomationService(
        dependencies({
          getBuffer: () => rig.buffer,
          getSessionState: rig.state,
          write: (_leafId, data) => {
            if (data === "Get-Date\r") {
              rig.buffer += "Get-Date\n";
              rig.running = true;
              setTimeout(() => {
                rig.buffer = repaint;
                rig.running = false;
                rig.generation += 1;
                rig.completions = [
                  { generation: rig.generation, exitCode: 0, at: Date.now() },
                ];
              }, 20);
            }
            return true;
          },
        }),
      );
      const executionId = idOf(
        await service.handle("terminal_execute", {
          ...target,
          text: "Get-Date",
        }),
      );
      const waited = await service.handle("terminal_wait", {
        ...target,
        executionId,
        timeout: 2_000,
      });
      expect(waited.result).toMatchObject({
        completed: true,
        reset: true,
        replayed,
      });
      expect(
        (waited.result as { output: string }).output.startsWith(start),
      ).toBe(true);
    }
  });

  it("times a command from when it was typed and says how long it queued", async () => {
    // Measured: a 90 s job read 110 s, 20 of them spent waiting for a new
    // shell's first prompt.
    vi.useFakeTimers();
    try {
      let state = startingShell();
      const service = createTerminalAutomationService(
        dependencies({ getSessionState: () => state }),
      );
      const executed = await service.handle("terminal_execute", {
        ...target,
        text: "echo late",
      });
      expect(executed.result).not.toHaveProperty("dispatched");
      await vi.advanceTimersByTimeAsync(5_000);
      state = {
        ...state,
        awaitingFirstPrompt: false,
        commandGeneration: 1,
        commandCompletions: [{ generation: 1, exitCode: 0 }],
      };
      await vi.advanceTimersByTimeAsync(1_000);
      state = {
        ...state,
        commandGeneration: 2,
        commandCompletions: [{ generation: 2, exitCode: 0, at: Date.now() }],
      };
      const waited = service.handle("terminal_wait", {
        ...target,
        executionId: idOf(executed),
        timeout: 1_000,
      });
      await vi.advanceTimersByTimeAsync(2_000);
      const result = (await waited).result as {
        durationMs: number;
        queuedMs: number;
      };
      expect(result.queuedMs).toBeGreaterThanOrEqual(5_000);
      expect(result.durationMs).toBeLessThan(1_500);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not hold a command on a foreground check that never answers", async () => {
    vi.useFakeTimers();
    try {
      const write = vi.fn(() => true);
      const service = createTerminalAutomationService(
        dependencies({
          hasForegroundProcess: () => new Promise<boolean>(() => {}),
          write,
        }),
      );
      const executed = service.handle("terminal_execute", {
        ...target,
        text: "echo hi",
      });
      await vi.advanceTimersByTimeAsync(4_000);
      await expect(executed).resolves.toMatchObject({
        result: { executed: true },
      });
      await vi.advanceTimersByTimeAsync(7_000);
      expect(write).toHaveBeenCalledWith(101, "echo hi\r");
    } finally {
      vi.useRealTimers();
    }
  });

  it("sees inserted text that echoed late with a line break in it", async () => {
    // Measured: inputVisible false while the text showed: the echo came after
    // 500 ms on a busy machine.
    let buffer = prompt;
    const service = createTerminalAutomationService(
      dependencies({
        getBuffer: () => buffer,
        write: (_leafId, data) => {
          setTimeout(() => {
            buffer = `${prompt}${data.slice(0, 10)}\n${data.slice(10)}`;
          }, 600);
          return true;
        },
      }),
    );
    await expect(
      service.handle("terminal_insert", {
        ...target,
        text: "echo dari-insert yang panjang",
      }),
    ).resolves.toMatchObject({ result: { inputVisible: true } });
  });

  it("keeps the start and the latest part of output too long for one answer", () => {
    const text = Array.from(
      { length: 50 },
      (_, index) => `row ${index} of a long log`,
    ).join("\n");
    const cut = clipExecutionOutput(text, 400);
    expect(cut.output.length).toBeLessThanOrEqual(400);
    expect(cut.output.startsWith("row 0 of a long log\n")).toBe(true);
    expect(cut.output.endsWith("row 49 of a long log")).toBe(true);
    expect(text.slice(cut.omittedFrom).startsWith("row ")).toBe(true);
    expect(clipExecutionOutput(text, 100)).toMatchObject({
      output: text.slice(-100),
      omittedFrom: 0,
    });
    expect(clipExecutionOutput("short", 400)).toMatchObject({
      output: "short",
      omittedChars: 0,
    });
  });
});

describe("terminal_wait output of a command whose start scrolled away", () => {
  const prompt = "PS C:\\work\\alpha> ";
  const target = { workspace: workspaceRoot, terminalId: "terminal:10:101" };

  /** A terminal whose buffer reads give only its last `window` lines. */
  function scrollingShell(window: number) {
    const rig = {
      lines: [`${prompt}`] as string[],
      generation: 2,
      running: false,
      completions: [] as { generation: number; exitCode: number; at: number }[],
      buffer: () => rig.lines.slice(-window).join("\n"),
      history: () => rig.lines.join("\n"),
      state: (): TerminalSessionState => ({
        ready: true,
        shellExited: false,
        commandRunning: rig.running,
        blockMode: rig.running ? "running" : "prompt",
        commandGeneration: rig.generation,
        commandCompletions: rig.completions,
        lastExitCode: 0,
        shell: "pwsh",
        inputPending: false,
      }),
      print(count: number, from: number) {
        for (let index = 0; index < count; index += 1) {
          rig.lines.push(`row ${from + index} of the job`);
        }
      },
      end() {
        rig.lines.push(prompt);
        rig.running = false;
        rig.generation += 1;
        rig.completions = [
          { generation: rig.generation, exitCode: 0, at: Date.now() },
        ];
      },
    };
    return rig;
  }

  it("finds the command in the scrollback after a burst scrolled it out of the lines read", async () => {
    // Measured: 700 lines at once shared nothing with the 400 lines read
    // before them, and the answer began at line 302.
    const rig = scrollingShell(5);
    const service = createTerminalAutomationService(
      dependencies({
        getBuffer: rig.buffer,
        getHistory: rig.history,
        getSessionState: rig.state,
        write: (_leafId, data) => {
          if (data === "node job.js\r") {
            rig.lines[rig.lines.length - 1] += "node job.js";
            rig.running = true;
            setTimeout(() => {
              rig.print(50, 1);
              rig.end();
            }, 20);
          }
          return true;
        },
      }),
    );
    const executed = await service.handle("terminal_execute", {
      ...target,
      text: "node job.js",
    });
    const waited = await service.handle("terminal_wait", {
      ...target,
      executionId: (executed.result as { executionId: string }).executionId,
      timeout: 2_000,
      maxChars: 400,
    });
    const result = waited.result as { output: string };
    expect(waited.result).toMatchObject({
      completed: true,
      reset: true,
      replayed: false,
      truncated: true,
    });
    expect(waited.result).not.toHaveProperty("omittedCursor");
    expect(result.output.startsWith("node job.js\nrow 1 of the job\n")).toBe(
      true,
    );
    expect(result.output).toContain("row 50 of the job");
  });

  it("answers a second run of the same long command, waited on after it ended", async () => {
    // Measured: the second run's last 400 lines matched the first run's, read
    // as no change, and its wait answered with nothing.
    const rig = scrollingShell(5);
    const service = createTerminalAutomationService(
      dependencies({
        getBuffer: rig.buffer,
        getHistory: rig.history,
        getSessionState: rig.state,
        write: (_leafId, data) => {
          if (data === "node job.js\r") {
            rig.lines[rig.lines.length - 1] += "node job.js";
            rig.running = true;
            rig.print(50, 1);
            rig.end();
          }
          return true;
        },
      }),
    );
    for (let run = 0; run < 2; run += 1) {
      const executed = await service.handle("terminal_execute", {
        ...target,
        text: "node job.js",
      });
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 400));
      const waited = await service.handle("terminal_wait", {
        ...target,
        executionId: (executed.result as { executionId: string }).executionId,
        timeout: 2_000,
      });
      const output = (waited.result as { output: string }).output;
      expect(
        output.startsWith("node job.js\nrow 1 of the job\n"),
        `run ${run}`,
      ).toBe(true);
      expect(output).toContain("row 50 of the job");
    }
  });

  it("reads along while a command runs, so steady output keeps its start", async () => {
    // 40 rows through a 16-row screen: a follow every 250 ms has 550 ms to
    // spare, which a loaded test run needs (8 rows left it 150 ms).
    const rig = scrollingShell(16);
    let printed = 0;
    let timer: ReturnType<typeof setInterval> | undefined;
    const service = createTerminalAutomationService(
      dependencies({
        getBuffer: rig.buffer,
        getSessionState: rig.state,
        write: (_leafId, data) => {
          if (data === "node job.js\r") {
            rig.lines[rig.lines.length - 1] += "node job.js";
            rig.running = true;
            timer = setInterval(() => {
              rig.print(2, printed + 1);
              printed += 2;
              if (printed >= 40) {
                clearInterval(timer);
                rig.end();
              }
            }, 100);
          }
          return true;
        },
      }),
    );
    const executed = await service.handle("terminal_execute", {
      ...target,
      text: "node job.js",
    });
    const waited = await service.handle("terminal_wait", {
      ...target,
      executionId: (executed.result as { executionId: string }).executionId,
      timeout: 5_000,
      maxChars: 12_000,
    });
    expect(waited.result).toMatchObject({ completed: true, reset: false });
    const output = (waited.result as { output: string }).output;
    expect(output.startsWith("node job.js\nrow 1 of the job\n")).toBe(true);
    expect(output).toContain("row 40 of the job");
  });
});

describe("a pager in a terminal", () => {
  it("knows less's and more's prompts", () => {
    expect(pagerOnScreen("diff --git a/x b/x\n+line\n:")).toBe(true);
    expect(pagerOnScreen("+last line\n(END)")).toBe(true);
    expect(pagerOnScreen("one\ntwo\n-- More (25%) --")).toBe(true);
    expect(pagerOnScreen("PS C:\\work\\alpha> ")).toBe(false);
    expect(pagerOnScreen("time: 12:30")).toBe(false);
  });

  it("quits a pager with q, which ignores Ctrl+C", async () => {
    // Measured: git diff opened less in an agent's terminal; Ctrl+C did
    // nothing and every later command read busy until the agent killed less.
    const write = vi.fn((_data: string) => true);
    let running = false;
    const service = createTerminalAutomationService(
      dependencies({
        getBuffer: () =>
          running ? "diff --git a/x b/x\n+line\n:" : "PS C:\\work\\alpha> ",
        getSessionState: () => ({
          ready: true,
          shellExited: false,
          commandRunning: running,
          blockMode: running ? "running" : "prompt",
          commandGeneration: 2,
          commandCompletions: [],
          lastExitCode: 0,
          shell: "pwsh",
          inputPending: false,
        }),
        write: (_leafId: number, data: string) => {
          write(data);
          if (data === "git diff\r") running = true;
          return true;
        },
      }),
    );
    const executed = await service.handle("terminal_execute", {
      workspace: workspaceRoot,
      terminalId: "terminal:10:101",
      text: "git diff",
    });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 400));
    await expect(
      service.handle("terminal_interrupt", {
        workspace: workspaceRoot,
        terminalId: "terminal:10:101",
        executionId: (executed.result as { executionId: string }).executionId,
      }),
    ).resolves.toMatchObject({ result: { ok: true, quitPager: true } });
    expect(write).toHaveBeenLastCalledWith("q");
    expect(write).not.toHaveBeenCalledWith("\x03");
  });
});

describe("terminals whose output stopped reaching Anbo", () => {
  // Measured (round 61): one lost output message left the terminal blind
  // while its shell had run the command. The execution read "dispatched" for
  // an hour, terminal_interrupt changed nothing, and terminal_close refused.
  const prompt = "PS C:\\work\\alpha> ";
  const target = { workspace: workspaceRoot, terminalId: "terminal:10:101" };
  const idOf = (response: { result?: unknown }) =>
    (response.result as { executionId: string }).executionId;
  const idleShell = (
    overrides: Partial<TerminalSessionState> = {},
  ): TerminalSessionState => ({
    ready: true,
    shellExited: false,
    commandRunning: false,
    blockMode: "prompt",
    commandGeneration: 2,
    commandCompletions: [],
    lastExitCode: 0,
    shell: "pwsh",
    inputPending: false,
    ...overrides,
  });

  it("ends an interrupted execution its shell never marked, once none of its programs is left", async () => {
    vi.useFakeTimers();
    try {
      const write = vi.fn(() => true);
      const service = createTerminalAutomationService(
        dependencies({
          getBuffer: () => prompt,
          getSessionState: () => idleShell(),
          write,
        }),
      );
      const executionId = idOf(
        await service.handle("terminal_execute", {
          ...target,
          text: "echo lost",
        }),
      );
      await vi.advanceTimersByTimeAsync(300);
      expect(write).toHaveBeenCalledWith(101, "echo lost\r");
      await expect(
        service.handle("terminal_interrupt", { ...target, executionId }),
      ).resolves.toMatchObject({
        result: { interrupted: true, phase: "dispatched" },
      });
      const waited = service.handle("terminal_wait", {
        ...target,
        executionId,
        timeout: 10_000,
      });
      await vi.advanceTimersByTimeAsync(7_000);
      await expect(waited).resolves.toMatchObject({
        result: {
          completed: true,
          completionReason: "interrupted",
          interrupted: true,
          endUnconfirmed: true,
          exitCode: null,
          note: expect.stringContaining("never marked the end"),
        },
      });
      await expect(
        service.handle("terminal_execute", { ...target, text: "echo next" }),
      ).resolves.toMatchObject({ result: { executed: true } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps waiting for an interrupted execution while one of its programs runs", async () => {
    vi.useFakeTimers();
    try {
      let running = false;
      const service = createTerminalAutomationService(
        dependencies({
          getBuffer: () => prompt,
          getSessionState: () => idleShell(),
          hasForegroundProcess: async () => running,
          write: () => true,
        }),
      );
      const executionId = idOf(
        await service.handle("terminal_execute", {
          ...target,
          text: "node serve.js",
        }),
      );
      await vi.advanceTimersByTimeAsync(300);
      running = true;
      await service.handle("terminal_interrupt", { ...target, executionId });
      const waited = service.handle("terminal_wait", {
        ...target,
        executionId,
        timeout: 8_000,
      });
      await vi.advanceTimersByTimeAsync(9_000);
      await expect(waited).resolves.toMatchObject({
        result: { completed: false, timedOut: true },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails a command whose input the PTY refused", async () => {
    vi.useFakeTimers();
    try {
      let writeError: TerminalSessionState["writeError"] = null;
      const service = createTerminalAutomationService(
        dependencies({
          getBuffer: () => prompt,
          getSessionState: () => idleShell({ writeError }),
          write: () => {
            writeError = {
              at: Date.now(),
              message: "pty_write: expected bytes",
            };
            return true;
          },
        }),
      );
      const executionId = idOf(
        await service.handle("terminal_execute", {
          ...target,
          text: "echo hi",
        }),
      );
      await vi.advanceTimersByTimeAsync(300);
      const waited = service.handle("terminal_wait", {
        ...target,
        executionId,
        timeout: 1_000,
      });
      await vi.advanceTimersByTimeAsync(1_500);
      await expect(waited).resolves.toMatchObject({
        result: {
          completed: true,
          completionReason: "dispatch_failed",
          dispatchError: expect.stringContaining(
            "did not take the command: pty_write: expected bytes",
          ),
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("says when the terminal's latest output has not arrived yet", async () => {
    vi.useFakeTimers();
    try {
      const service = createTerminalAutomationService(
        dependencies({
          getBuffer: () => prompt,
          getSessionState: () =>
            idleShell({ outputStalledSince: Date.now() - 3_000 }),
          write: () => true,
        }),
      );
      const executionId = idOf(
        await service.handle("terminal_execute", {
          ...target,
          text: "echo hi",
        }),
      );
      await vi.advanceTimersByTimeAsync(300);
      const waited = service.handle("terminal_wait", {
        ...target,
        executionId,
        timeout: 500,
      });
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(waited).resolves.toMatchObject({
        result: {
          completed: false,
          outputStalled: true,
          note: expect.stringContaining("asking for it again"),
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("names the program holding an opened terminal and closes it when forced", async () => {
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
        foregroundProcesses: async () => [{ pid: 4242, name: "node.exe" }],
      }),
    );
    await service.handle("terminal_open", {
      workspace: workspaceRoot,
      title: "Dev Server",
    });
    const opened = { workspace: workspaceRoot, terminalId: "terminal:20:201" };
    await expect(
      service.handle("terminal_execute", { ...opened, text: "echo hi" }),
    ).resolves.toMatchObject({
      error: {
        code: "terminal_busy",
        message: expect.stringContaining("it runs node.exe (pid 4242)"),
      },
    });
    await expect(
      service.handle("terminal_close", opened),
    ).resolves.toMatchObject({
      error: {
        code: "terminal_busy",
        message: expect.stringMatching(/node\.exe \(pid 4242\).*force: true/),
      },
    });
    expect(close).not.toHaveBeenCalled();
    await expect(
      service.handle("terminal_close", { ...opened, force: true }),
    ).resolves.toMatchObject({ result: { closed: true, forced: true } });
    expect(close).toHaveBeenCalledWith(20, 201);
  });

  it("closes a terminal held by an execution only when forced", async () => {
    vi.useFakeTimers();
    try {
      const openedTab = terminal({
        id: 20,
        title: "Notes",
        paneTree: { kind: "leaf", id: 201, cwd: workspaceRoot },
        activeLeafId: 201,
      });
      const close = vi.fn(() => true);
      const service = createTerminalAutomationService(
        dependencies({
          getTabs: () => [terminal(), openedTab],
          getBuffer: () => prompt,
          getSessionState: () => idleShell(),
          open: () => ({ tabId: 20, leafId: 201 }),
          close,
        }),
      );
      await service.handle("terminal_open", {
        workspace: workspaceRoot,
        title: "Notes",
      });
      const opened = {
        workspace: workspaceRoot,
        terminalId: "terminal:20:201",
      };
      await service.handle("terminal_execute", {
        ...opened,
        text: "echo lost",
      });
      await vi.advanceTimersByTimeAsync(300);
      await expect(
        service.handle("terminal_close", opened),
      ).resolves.toMatchObject({
        error: {
          code: "terminal_busy",
          message: expect.stringContaining("force: true closes it anyway"),
        },
      });
      await expect(
        service.handle("terminal_close", { ...opened, force: true }),
      ).resolves.toMatchObject({ result: { closed: true, forced: true } });
      expect(close).toHaveBeenCalledWith(20, 201);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a prompt redraw while a command is sent", () => {
  it("does not end the command at it", async () => {
    // Measured (round 60): terminal_wait answered the Ctrl+C's exit code
    // -1073741510 and durationMs -4 for "echo selesai".
    vi.useFakeTimers();
    try {
      let generation = 2;
      let completions: { generation: number; exitCode: number; at: number }[] =
        [];
      let checks = 0;
      const state = (): TerminalSessionState => ({
        ready: true,
        shellExited: false,
        commandRunning: false,
        blockMode: "prompt",
        commandGeneration: generation,
        commandCompletions: completions,
        lastExitCode: 0,
        shell: "pwsh",
        inputPending: false,
      });
      const service = createTerminalAutomationService(
        dependencies({
          getBuffer: () => "PS C:\\work\\alpha> ",
          getSessionState: state,
          hasForegroundProcess: async () => {
            checks += 1;
            // The second check is the last one before the write.
            if (checks === 2) {
              generation += 1;
              completions = [
                ...completions,
                { generation, exitCode: -1073741510, at: Date.now() },
              ];
            }
            return false;
          },
          write: () => true,
        }),
      );
      const executed = await service.handle("terminal_execute", {
        workspace: workspaceRoot,
        terminalId: "terminal:10:101",
        text: "echo selesai",
      });
      await vi.advanceTimersByTimeAsync(300);
      const waited = service.handle("terminal_wait", {
        workspace: workspaceRoot,
        terminalId: "terminal:10:101",
        executionId: (executed.result as { executionId: string }).executionId,
        timeout: 2_000,
      });
      await vi.advanceTimersByTimeAsync(500);
      generation += 1;
      completions = [
        ...completions,
        { generation, exitCode: 0, at: Date.now() },
      ];
      await vi.advanceTimersByTimeAsync(2_000);
      const result = (await waited).result as {
        completed: boolean;
        exitCode: number | null;
        durationMs: number;
      };
      expect(result).toMatchObject({ completed: true, exitCode: 0 });
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a terminal just opened", () => {
  it("is found while its tab enters the tab list", async () => {
    // Measured (round 61): terminal_execute in the same script as its
    // terminal_open answered terminal_not_found one time in three.
    vi.useFakeTimers();
    try {
      let listed = false;
      const openedTab = terminal({
        id: 20,
        title: "Tests",
        paneTree: { kind: "leaf", id: 201, cwd: workspaceRoot },
        activeLeafId: 201,
      });
      const service = createTerminalAutomationService(
        dependencies({
          getTabs: () => (listed ? [terminal(), openedTab] : [terminal()]),
          open: () => {
            setTimeout(() => {
              listed = true;
            }, 60);
            return { tabId: 20, leafId: 201 };
          },
        }),
      );
      await service.handle("terminal_open", {
        workspace: workspaceRoot,
        title: "Tests",
      });
      const executed = service.handle("terminal_execute", {
        workspace: workspaceRoot,
        terminalId: "terminal:20:201",
        text: "echo hi",
      });
      await vi.advanceTimersByTimeAsync(150);
      await expect(executed).resolves.toMatchObject({
        result: { executed: true },
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
