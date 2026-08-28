import type { SpaceMeta } from "@/modules/spaces/lib/store";
import type { TerminalTab } from "@/modules/tabs";
import { describe, expect, it, vi } from "vitest";
import {
  collectSharedTerminals,
  createTerminalAutomationService,
  sanitizeTerminalInput,
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
    const service = createTerminalAutomationService(
      dependencies({
        write: (leafId, data) => {
          writes.push([leafId, data]);
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
    ).resolves.toMatchObject({ result: { ok: true, executed: false } });
    expect(writes).toEqual([[101, "git status"]]);

    writes.length = 0;
    await expect(
      service.handle("terminal_execute", {
        workspace: workspace.root,
        terminalId: "terminal:10:101",
        text: "pnpm test",
      }),
    ).resolves.toMatchObject({ result: { ok: true, executed: true } });
    expect(writes).toEqual([[101, "pnpm test\r"]]);
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

  it("checks foreground work once for execute and not during OSC wait", async () => {
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

    expect(hasForegroundProcess).toHaveBeenCalledTimes(1);
  });

  it("prepares a released renderer before executing so OSC completion stays observable", async () => {
    const prepare = vi.fn(() => false);
    const write = vi.fn(() => true);
    const service = createTerminalAutomationService(
      dependencies({ prepare, write }),
    );

    await expect(
      service.handle("terminal_execute", {
        workspace: workspace.root,
        terminalId: "terminal:10:101",
        text: "echo tracked",
      }),
    ).resolves.toMatchObject({
      error: { code: "terminal_unavailable" },
    });
    expect(prepare).toHaveBeenCalledWith(101);
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
          lastExitCode: generation > 2 ? 7 : 0,
          shell: "pwsh",
        }),
        write: () => {
          running = true;
          setTimeout(() => {
            buffer += "\ncommand output\nPS C:\\work\\alpha>";
            running = false;
            generation += 1;
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
        exitCode: 7,
        output: expect.stringContaining("command output"),
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
