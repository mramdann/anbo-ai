import type { AgentSession } from "@/modules/agents/lib/types";
import type { SpaceMeta } from "@/modules/spaces/lib/store";
import type { Tab, TerminalTab } from "@/modules/tabs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentOutputTracker,
  agentIdFor,
  collectWorkspaceAgents,
  createAgentAutomationService as createService,
  isAgentTuiReady,
  resolveAgentWorkspace,
  sanitizeAgentMessage,
  submitAgentMessage,
} from "./agentAutomation";

type TestDependencies = Omit<Parameters<typeof createService>[0], "prepare"> & {
  prepare?: (leafId: number) => boolean;
};
const createAgentAutomationService = (deps: TestDependencies) =>
  createService({ prepare: () => true, ...deps });

const space = (overrides: Partial<SpaceMeta> = {}): SpaceMeta => ({
  id: "space-a",
  name: "Alpha",
  root: "C:/work/alpha",
  env: { kind: "local" },
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

const terminalTab = (overrides: Partial<TerminalTab> = {}): TerminalTab => ({
  id: 10,
  kind: "terminal",
  title: "Atlas",
  spaceId: "space-a",
  paneTree: {
    kind: "leaf",
    id: 101,
    agentResume: {
      agent: "claude",
      command: "claude",
      sessionId: "00000000-0000-4000-8000-000000000001",
    },
  },
  activeLeafId: 101,
  ...overrides,
});

const session = (overrides: Partial<AgentSession> = {}): AgentSession => ({
  leafId: 101,
  tabId: 10,
  agent: "claude",
  name: "Atlas",
  status: "waiting",
  phase: "finished",
  startedAt: 10,
  lastActivityAt: 20,
  attentionSince: 20,
  ...overrides,
});

afterEach(() => {
  vi.useRealTimers();
});

describe("agent workspace scoping", () => {
  it("returns a memory admission failure without typing or waiting for spawn", async () => {
    const write = vi.fn(() => true);
    const service = createAgentAutomationService({
      getTabs: () => [terminalTab()],
      getSpaces: () => [space()],
      getSessions: () => ({}),
      getActiveTabId: () => null,
      getBuffer: () => null,
      write,
      spawn: async () => {
        throw "resource_exhausted: Close unused tabs and retry";
      },
      subscribeSessions: () => () => {},
    });
    await expect(
      service.handle({
        requestId: "pressure",
        method: "agent_spawn",
        params: { workspace: "space-a", agent: "opencode" },
      }),
    ).resolves.toMatchObject({ error: { code: "resource_exhausted" } });
    expect(write).not.toHaveBeenCalled();
    service.dispose();
  });

  it("does not send input when a live terminal buffer cannot be prepared", async () => {
    const write = vi.fn(() => true);
    const service = createAgentAutomationService({
      getTabs: () => [terminalTab()],
      getSpaces: () => [space()],
      getSessions: () => ({ 101: session() }),
      getActiveTabId: () => null,
      getBuffer: () => "ready",
      prepare: () => false,
      write,
      spawn: () => null,
      subscribeSessions: () => () => {},
    });
    await expect(
      service.handle({
        requestId: "buffer-pressure",
        method: "agent_send",
        params: {
          workspace: "space-a",
          agentId: "atlas-claude:10",
          message: "do not submit",
        },
      }),
    ).resolves.toMatchObject({ error: { code: "agent_not_ready" } });
    expect(write).not.toHaveBeenCalled();
    service.dispose();
  });
  it("uses a readable workspace-scoped callsign and CLI id", () => {
    expect(agentIdFor("Lucian", "claude", 14)).toBe("lucian-claude:14");
    expect(agentIdFor("Claude", "claude", 14)).toBe("claude:14");
  });

  it("requires an explicit open workspace and normalizes Windows paths", () => {
    expect(resolveAgentWorkspace([space()], undefined).ok).toBe(false);
    expect(resolveAgentWorkspace([space()], "c:\\WORK\\alpha\\")).toMatchObject(
      { ok: true, space: { id: "space-a" } },
    );
    expect(resolveAgentWorkspace([space()], "space-a")).toMatchObject({
      ok: true,
      space: { root: "C:/work/alpha" },
    });
  });

  it("returns only live non-private agents in the selected workspace", () => {
    const privateTab = terminalTab({ id: 11, private: true });
    privateTab.paneTree = { kind: "leaf", id: 102 };
    const otherSpace = terminalTab({ id: 12, spaceId: "space-b" });
    otherSpace.paneTree = { kind: "leaf", id: 103 };
    const agents = collectWorkspaceAgents(
      [terminalTab(), privateTab, otherSpace],
      {
        101: session(),
        102: session({ leafId: 102, tabId: 11, name: "Hidden" }),
        103: session({ leafId: 103, tabId: 12, name: "Elsewhere" }),
      },
      { id: "space-a", root: "C:/work/alpha" },
      10,
    );
    expect(agents).toEqual([
      expect.objectContaining({
        agentId: agentIdFor("Atlas", "claude", 10),
        leafId: 101,
        name: "Atlas",
        active: true,
        sessionId: "00000000-0000-4000-8000-000000000001",
      }),
    ]);
  });
});

describe("agent output cursor", () => {
  it("redacts secrets and returns only output after a valid cursor", () => {
    const tracker = new AgentOutputTracker();
    const first = tracker.read(
      "agent:space-a:101",
      "start API_KEY=supersecretvalue",
      undefined,
      4_000,
    );
    expect(first.output).toContain("API_KEY=<REDACTED>");
    const second = tracker.read(
      "agent:space-a:101",
      "start API_KEY=supersecretvalue\nnext",
      first.cursor,
      4_000,
    );
    expect(second).toMatchObject({ output: "\nnext", reset: false });
  });

  it("marks an expired cursor as reset after terminal history is replaced", () => {
    const tracker = new AgentOutputTracker();
    const first = tracker.read(
      "agent:space-a:101",
      "old output",
      undefined,
      100,
    );
    const second = tracker.read(
      "agent:space-a:101",
      "completely replaced",
      first.cursor,
      100,
    );
    expect(second).toMatchObject({
      output: "completely replaced",
      reset: true,
    });
  });
});

describe("agent messages", () => {
  it("normalizes multiline instructions and rejects controls", () => {
    expect(sanitizeAgentMessage("  inspect this\nthen report  ")).toEqual({
      ok: true,
      message: "inspect this then report",
    });
    expect(sanitizeAgentMessage("bad\u0007")).toMatchObject({ ok: false });
  });

  it("recognizes stable prompts for every built-in agent CLI", () => {
    expect(
      isAgentTuiReady("claude", "Claude Code\nPress ? for shortcuts\n❯ "),
    ).toBe(true);
    expect(
      isAgentTuiReady(
        "codex",
        "OpenAI Codex\nmodel: gpt-5.6-sol /model to change\n› Ask Codex to do anything",
      ),
    ).toBe(true);
    expect(
      isAgentTuiReady(
        "codex",
        "Previous response\n› Improve documentation in @filename\n\ngpt-5.6-sol high",
      ),
    ).toBe(true);
    expect(
      isAgentTuiReady("antigravity", "Antigravity CLI\n? for shortcuts\n>"),
    ).toBe(true);
    expect(
      isAgentTuiReady(
        "antigravity",
        "Antigravity CLI\nSigning in...\nPS C:\\work\\alpha>",
      ),
    ).toBe(false);
    expect(isAgentTuiReady("opencode", "ready\nctrl+p commands")).toBe(true);
    expect(
      isAgentTuiReady(
        "codex",
        "OpenAI Codex\n2. Trust all and continue\nPress enter to confirm",
      ),
    ).toBe(false);
    expect(
      isAgentTuiReady(
        "codex",
        "This command requires approval\n› 1. Yes\n\ngpt-5.6-sol high",
      ),
    ).toBe(false);
  });

  it("reports the callsign the workspace gave the agent, not the CLI label", () => {
    // "codex:11" says which CLI and which tab. It is an address, not a name.
    const space = { id: "sp-1", root: "C:/work" };
    const tabs = [
      {
        id: 7,
        kind: "terminal",
        spaceId: "sp-1",
        activeLeafId: 8,
        paneTree: { kind: "leaf", id: 8 },
        agent: {
          launcherId: "codex",
          icon: "codex",
          label: "Codex",
          name: "Alnilam",
        },
      },
    ] as never;
    const sessions = {
      8: {
        tabId: 7,
        leafId: 8,
        name: "Codex",
        agent: "codex",
        status: "waiting",
        startedAt: 1,
        lastActivityAt: 2,
      },
    } as never;

    const [agent] = collectWorkspaceAgents(tabs, sessions, space, null);
    expect(agent.name).toBe("Alnilam");
    expect(agent.cli).toBe("codex");
    expect(agent.agentId).toContain("codex");
  });

  it("verifies an input echo even when a TUI inserts ANSI repaint codes", async () => {
    const writes: string[] = [];
    let reads = 0;
    const message = "Choose Alpha or Beta";
    const submitted = await submitAgentMessage(
      (_leafId, data) => {
        writes.push(data);
        return true;
      },
      () => {
        reads += 1;
        return reads === 1
          ? "Antigravity CLI\n>"
          : "Choose\x1b[>4;2m Alpha\x1b[>4;2m or Beta";
      },
      101,
      message,
      true,
    );

    expect(submitted).toBe(true);
    expect(writes).toEqual([message, "\r"]);
  });

  it("verifies an input echo that a bordered TUI wraps across rows", async () => {
    const writes: string[] = [];
    let reads = 0;
    // OpenCode draws its prompt inside a box, so a message wider than the box
    // comes back split across rows with a border glyph between the fragments.
    const message =
      "Buka contoh dot com di workspace erp lalu tutup lagi tabnya tanpa menyentuh workspace lain";
    const half = Math.ceil(message.length / 2);
    const submitted = await submitAgentMessage(
      (_leafId, data) => {
        writes.push(data);
        return true;
      },
      () => {
        reads += 1;
        return reads === 1
          ? "OpenCode 1.18.27\n┃"
          : `┃ ${message.slice(0, half)}\n┃ ${message.slice(half)}`;
      },
      103,
      message,
      true,
    );

    expect(submitted).toBe(true);
    expect(writes).toEqual([message, "\r"]);
  });

  it("allows Antigravity input to settle before pressing Enter", async () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    const message =
      "Tes produksi Anbo. Jangan ubah file. Balas tepat: ANBO_PROD_ANTIGRAVITY_OK";
    const pending = submitAgentMessage(
      (_leafId, data) => {
        writes.push(data);
        return true;
      },
      () => "Antigravity CLI\n>",
      102,
      message,
      false,
      750,
    );

    await vi.advanceTimersByTimeAsync(749);
    expect(writes).toEqual([message]);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBe(true);
    expect(writes).toEqual([message, "\r"]);
  });

  it("delivers long instructions in acknowledged chunks before one Enter", async () => {
    vi.useFakeTimers();
    const message = "Record for delivery verification. ".repeat(120);
    const writes: string[] = [];
    let buffer = "Claude Code\n\u276f ";
    const pending = submitAgentMessage(
      (_leafId, data) => {
        writes.push(data);
        if (data !== "\r") {
          setTimeout(() => {
            buffer += data.length > 256 ? "[Pasted text #1]" : data;
          }, 40);
        }
        return true;
      },
      () => buffer,
      101,
      message,
      true,
    );
    await vi.advanceTimersByTimeAsync(8_100);
    await expect(pending).resolves.toBe(true);
    expect(writes.slice(0, -1).join("")).toBe(message);
    expect(writes.slice(0, -1).every((chunk) => chunk.length <= 256)).toBe(
      true,
    );
    expect(writes.filter((data) => data === "\r")).toEqual(["\r"]);
  });

  it("never sends later chunks or Enter after an unacknowledged chunk", async () => {
    vi.useFakeTimers();
    const message = "first section ".repeat(30) + "unique final section";
    const writes: string[] = [];
    let buffer = "\u276f ";
    const pending = submitAgentMessage(
      (_leafId, data) => {
        writes.push(data);
        if (writes.length === 1) buffer += data;
        return true;
      },
      () => buffer,
      101,
      message,
      true,
      90,
      200,
    );
    await vi.advanceTimersByTimeAsync(225);
    await expect(pending).resolves.toBe(false);
    expect(writes).toEqual([message.slice(0, 256), message.slice(256), "\x03"]);
  });

  it("does not treat a collapsed paste marker as verified message contents", async () => {
    vi.useFakeTimers();
    let buffer = "\u276f ";
    const writes: string[] = [];
    const pending = submitAgentMessage(
      (_leafId, data) => {
        writes.push(data);
        buffer += "[Pasted text #1]";
        return true;
      },
      () => buffer,
      101,
      "Confirm the complete instruction before submitting".repeat(40),
      true,
      90,
      100,
    );
    await vi.advanceTimersByTimeAsync(125);
    await expect(pending).resolves.toBe(false);
    expect(writes).toHaveLength(2);
    expect(writes[0]).toHaveLength(256);
    expect(writes[1]).toBe("\x03");
  });

  it("preserves Unicode pairs at chunk boundaries and cancels failed writes", async () => {
    vi.useFakeTimers();
    const message = `${"a".repeat(255)}\u{10437}${"b".repeat(300)}`;
    let buffer = "\u276f ";
    const writes: string[] = [];
    const pending = submitAgentMessage(
      (_leafId, data) => {
        writes.push(data);
        if (writes.length === 3) return false;
        buffer += data;
        return true;
      },
      () => buffer,
      101,
      message,
      true,
    );
    await vi.advanceTimersByTimeAsync(100);
    await expect(pending).resolves.toBe(false);
    expect(writes[0]).toHaveLength(255);
    expect(writes[1].startsWith("\u{10437}")).toBe(true);
    expect(writes.slice(0, -1).join("")).toBe(message);
    expect(writes[writes.length - 1]).toBe("\x03");
    expect(writes).not.toContain("\r");
  });

  it("does not type into a Codex trust prompt while a spawned CLI starts", async () => {
    vi.useFakeTimers();
    let buffer =
      "OpenAI Codex\n1. Review hooks\n2. Trust all and continue\nPress enter to confirm";
    const writes: Array<[number, string]> = [];
    const service = createAgentAutomationService({
      getTabs: () => [terminalTab()] as Tab[],
      getSpaces: () => [space()],
      getSessions: () => ({
        101: session({ agent: "codex", name: "Spica" }),
      }),
      getActiveTabId: () => null,
      getBuffer: () => buffer,
      write: (leafId, data) => {
        writes.push([leafId, data]);
        return true;
      },
      spawn: () => null,
      subscribeSessions: () => () => {},
    });

    const pending = service.handle({
      requestId: "send-after-spawn",
      method: "agent_send",
      params: {
        workspace: "space-a",
        agentId: "spica-codex:10",
        message: "SPICA AGENT OK",
        timeout: 2_000,
      },
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(writes).toEqual([]);

    buffer =
      "OpenAI Codex\nmodel: gpt-5.6-sol /model to change\n\n› Ask Codex to do anything";
    await vi.advanceTimersByTimeAsync(500);
    expect(writes).toEqual([[101, "SPICA AGENT OK"]]);
    buffer += "\nSPICAAGENTOK";
    await vi.advanceTimersByTimeAsync(100);
    await expect(pending).resolves.toMatchObject({ result: { ok: true } });
    expect(writes).toEqual([
      [101, "SPICA AGENT OK"],
      [101, "\r"],
    ]);
    service.dispose();
  });

  it("submits to the requested waiting leaf without changing UI focus", async () => {
    vi.useFakeTimers();
    let sessions: Record<number, AgentSession> = { 101: session() };
    const writes: Array<[number, string]> = [];
    const service = createAgentAutomationService({
      getTabs: () => [terminalTab()] as Tab[],
      getSpaces: () => [space()],
      getSessions: () => sessions,
      getActiveTabId: () => null,
      getBuffer: () => "ready",
      write: (leafId, data) => {
        writes.push([leafId, data]);
        return true;
      },
      spawn: () => null,
      subscribeSessions: () => () => {},
    });
    const pending = service.handle({
      requestId: "request-1",
      method: "agent_send",
      params: {
        workspace: "C:/work/alpha",
        agentId: agentIdFor("Atlas", "claude", 10),
        message: "continue",
      },
    });
    await vi.advanceTimersByTimeAsync(100);
    await expect(pending).resolves.toMatchObject({ result: { ok: true } });
    expect(writes).toEqual([
      [101, "continue"],
      [101, "\r"],
    ]);
    sessions = {};
    service.dispose();
  });

  it("waits until Codex renders the input before pressing Enter", async () => {
    vi.useFakeTimers();
    let buffer =
      "OpenAI Codex\nmodel: gpt-5.6-sol /model to change\n\n› Ask Codex to do anything";
    const writes: Array<[number, string]> = [];
    const service = createAgentAutomationService({
      getTabs: () => [terminalTab()] as Tab[],
      getSpaces: () => [space()],
      getSessions: () => ({
        101: session({ agent: "codex", name: "Spica" }),
      }),
      getActiveTabId: () => null,
      getBuffer: () => buffer,
      write: (leafId, data) => {
        writes.push([leafId, data]);
        return true;
      },
      spawn: () => null,
      subscribeSessions: () => () => {},
    });

    const pending = service.handle({
      requestId: "request-codex",
      method: "agent_send",
      params: {
        workspace: "space-a",
        agentId: "spica-codex:10",
        message: "SPICA AGENT OK",
      },
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(writes).toEqual([[101, "SPICA AGENT OK"]]);
    buffer += "\nSPICAAGENTOK";
    await vi.advanceTimersByTimeAsync(25);
    await expect(pending).resolves.toMatchObject({ result: { ok: true } });
    expect(writes).toEqual([
      [101, "SPICA AGENT OK"],
      [101, "\r"],
    ]);
    service.dispose();
  });

  it("does not acknowledge or submit Codex input that was never rendered", async () => {
    vi.useFakeTimers();
    const writes: Array<[number, string]> = [];
    const service = createAgentAutomationService({
      getTabs: () => [terminalTab()] as Tab[],
      getSpaces: () => [space()],
      getSessions: () => ({
        101: session({ agent: "codex", name: "Spica" }),
      }),
      getActiveTabId: () => null,
      getBuffer: () => "Codex is still starting",
      write: (leafId, data) => {
        writes.push([leafId, data]);
        return true;
      },
      spawn: () => null,
      subscribeSessions: () => () => {},
    });

    const pending = service.handle({
      requestId: "request-codex-not-ready",
      method: "agent_send",
      params: {
        workspace: "space-a",
        agentId: "spica-codex:10",
        message: "SPICA AGENT OK",
        timeout: 8_000,
      },
    });
    await vi.advanceTimersByTimeAsync(8_100);
    await expect(pending).resolves.toMatchObject({
      error: { code: "agent_not_ready" },
    });
    expect(writes).toEqual([]);
    service.dispose();
  });

  it("sends immediately to a working agent when readiness waiting is disabled", async () => {
    vi.useFakeTimers();
    const writes: Array<[number, string]> = [];
    const service = createAgentAutomationService({
      getTabs: () => [terminalTab()] as Tab[],
      getSpaces: () => [space()],
      getSessions: () => ({
        101: session({ status: "working", phase: "working" }),
      }),
      getActiveTabId: () => null,
      getBuffer: () => "ready",
      write: (leafId, data) => {
        writes.push([leafId, data]);
        return true;
      },
      spawn: () => null,
      subscribeSessions: () => () => {},
    });

    const pending = service.handle({
      requestId: "request-direct",
      method: "agent_send",
      params: {
        workspace: "space-a",
        agentId: "atlas-claude:10",
        message: "inspect the workspace",
        waitForReady: false,
      },
    });
    await vi.advanceTimersByTimeAsync(100);
    await expect(pending).resolves.toMatchObject({ result: { ok: true } });
    expect(writes).toEqual([
      [101, "inspect the workspace"],
      [101, "\r"],
    ]);
    service.dispose();
  });

  it("cancels unverified input and reserves its message id before a retry", async () => {
    vi.useFakeTimers();
    const message = "delegate this task once";
    const writes: string[] = [];
    const service = createAgentAutomationService({
      getTabs: () => [terminalTab()] as Tab[],
      getSpaces: () => [space()],
      getSessions: () => ({
        101: session({ agent: "codex", name: "Spica" }),
      }),
      getActiveTabId: () => null,
      getBuffer: () =>
        "OpenAI Codex\nmodel: gpt-5.6-sol /model to change\n\nâ€º Ask Codex to do anything",
      write: (_leafId, data) => {
        writes.push(data);
        return true;
      },
      spawn: () => null,
      subscribeSessions: () => () => {},
    });

    const first = service.handle({
      requestId: "unverified-first",
      method: "agent_send",
      params: {
        workspace: "space-a",
        agentId: "spica-codex:10",
        message,
        messageId: "delegate-once",
        timeout: 100,
        waitForReady: false,
      },
    });
    await vi.advanceTimersByTimeAsync(125);
    await expect(first).resolves.toMatchObject({
      error: { code: "agent_not_ready" },
    });
    expect(writes).toEqual([message, "\x03"]);

    await expect(
      service.handle({
        requestId: "unverified-retry",
        method: "agent_send",
        params: {
          workspace: "space-a",
          agentId: "spica-codex:10",
          message,
          messageId: "delegate-once",
          timeout: 100,
          waitForReady: false,
        },
      }),
    ).resolves.toMatchObject({ error: { code: "duplicate_message" } });
    expect(writes).toEqual([message, "\x03"]);
    service.dispose();
  });

  it("accepts the next message after terminal output acknowledges a fast turn", async () => {
    vi.useFakeTimers();
    let buffer = "Claude Code\nmanual mode on\nâ¯ ";
    const writes: string[] = [];
    const service = createAgentAutomationService({
      getTabs: () => [terminalTab()] as Tab[],
      getSpaces: () => [space()],
      getSessions: () => ({ 101: session() }),
      getActiveTabId: () => null,
      getBuffer: () => buffer,
      write: (_leafId, data) => {
        writes.push(data);
        if (data === "first") {
          setTimeout(() => {
            buffer += "\nfirst\nanswer\nâ¯ ";
          }, 200);
        }
        return true;
      },
      spawn: () => null,
      subscribeSessions: () => () => {},
    });

    const first = service.handle({
      requestId: "first",
      method: "agent_send",
      params: {
        workspace: "space-a",
        agentId: "atlas-claude:10",
        message: "first",
      },
    });
    await vi.advanceTimersByTimeAsync(100);
    await expect(first).resolves.toMatchObject({ result: { ok: true } });

    const second = service.handle({
      requestId: "second",
      method: "agent_send",
      params: {
        workspace: "space-a",
        agentId: "atlas-claude:10",
        message: "second",
      },
    });
    await vi.advanceTimersByTimeAsync(500);
    await expect(second).resolves.toMatchObject({ result: { ok: true } });
    expect(writes).toEqual(["first", "\r", "second", "\r"]);
    service.dispose();
  });

  it("waits for the distinct finished phase", async () => {
    let sessions: Record<number, AgentSession> = {
      101: session({ status: "working", phase: "working" }),
    };
    let notify = (
      _current: Record<number, AgentSession>,
      _previous: Record<number, AgentSession>,
    ) => {};
    const service = createAgentAutomationService({
      getTabs: () => [terminalTab()] as Tab[],
      getSpaces: () => [space()],
      getSessions: () => sessions,
      getActiveTabId: () => null,
      getBuffer: () => "",
      write: () => true,
      spawn: () => null,
      subscribeSessions: (next) => {
        notify = next;
        return () => {
          notify = () => {};
        };
      },
    });
    const pending = service.handle({
      requestId: "request-2",
      method: "agent_wait",
      params: {
        workspace: "space-a",
        agentId: agentIdFor("Atlas", "claude", 10),
        status: "finished",
        timeout: 1_000,
      },
    });
    const previous = sessions;
    sessions = {
      101: session({
        status: "waiting",
        phase: "finished",
        lastActivityAt: 30,
      }),
    };
    notify(sessions, previous);
    await expect(pending).resolves.toMatchObject({
      result: {
        matched: true,
        agent: { phase: "finished" },
      },
    });
    service.dispose();
  });

  it("matches waiting status when an agent transitions into attention phase", async () => {
    let notify: (
      sessions: Record<number, AgentSession>,
      previous: Record<number, AgentSession>,
    ) => void = () => {};
    let sessions: Record<number, AgentSession> = {
      101: session({
        status: "working",
        phase: "working",
        lastActivityAt: 10,
      }),
    };
    const service = createAgentAutomationService({
      getTabs: () => [terminalTab({ title: "Claude" })],
      getSpaces: () => [space()],
      getSessions: () => sessions,
      getActiveTabId: () => 10,
      getBuffer: () => "",
      write: () => true,
      spawn: () => null,
      subscribeSessions: (next) => {
        notify = next;
        return () => {
          notify = () => {};
        };
      },
    });
    const pending = service.handle({
      requestId: "request-3",
      method: "agent_wait",
      params: {
        workspace: "space-a",
        agentId: agentIdFor("Atlas", "claude", 10),
        status: "waiting",
        timeout: 1_000,
      },
    });
    const previous = sessions;
    sessions = {
      101: session({
        status: "working",
        phase: "attention",
        lastActivityAt: 25,
      }),
    };
    notify(sessions, previous);
    await expect(pending).resolves.toMatchObject({
      result: {
        matched: true,
        agent: { status: "working", phase: "attention" },
      },
    });
    service.dispose();
  });
});

describe("agent spawning", () => {
  it("reports a first agent selected by the workspace opener", async () => {
    const service = createAgentAutomationService({
      getTabs: () => [terminalTab()],
      getSpaces: () => [space()],
      getSessions: () => ({ 101: session() }),
      getActiveTabId: () => 10,
      getBuffer: () => "",
      prepare: () => true,
      write: () => true,
      spawn: () => ({
        agentId: "claude:10",
        cli: "claude",
        tabId: 10,
        leafId: 101,
        spaceId: "space-a",
        workspace: "C:/work/alpha",
        activated: true,
      }),
      subscribeSessions: () => () => {},
    });
    await expect(
      service.handle({
        requestId: "first-agent",
        method: "agent_spawn",
        params: { workspace: "space-a", agent: "claude", timeout: 100 },
      }),
    ).resolves.toMatchObject({
      result: {
        placement: "visible-first-tab",
        pending: false,
        agent: { active: true, tabId: 10 },
      },
    });
    service.dispose();
  });
  it("spawns one configured custom agent in the explicit workspace without changing focus", async () => {
    let tabs: Tab[] = [];
    let sessions: Record<number, AgentSession> = {};
    const writes: Array<[number, string]> = [];
    const activeTabId = 77;
    const service = createAgentAutomationService({
      getTabs: () => tabs,
      getSpaces: () => [space()],
      getSessions: () => sessions,
      getActiveTabId: () => activeTabId,
      getBuffer: () => writes.map(([, data]) => data).join(""),
      write: (leafId, data) => {
        writes.push([leafId, data]);
        return true;
      },
      spawn: (workspace, agent) => {
        expect(workspace).toEqual({ id: "space-a", root: "C:/work/alpha" });
        expect(agent).toBe("custom:sample-cli");
        tabs = [terminalTab({ title: "Claude" })];
        sessions = {
          101: session({
            agent: "custom:sample-cli",
            name: "Sample",
            status: "working",
            phase: "working",
          }),
        };
        return {
          agentId: agentIdFor(agent, agent, 10),
          cli: agent,
          tabId: 10,
          leafId: 101,
          spaceId: workspace.id,
          workspace: workspace.root,
        };
      },
      subscribeSessions: () => () => {},
    });

    await expect(
      service.handle({
        requestId: "spawn-1",
        method: "agent_spawn",
        params: { workspace: "space-a", agent: "custom:sample-cli" },
      }),
    ).resolves.toMatchObject({
      result: {
        ok: true,
        pending: false,
        placement: "background",
        agent: {
          agentId: "sample-sample-cli:10",
          name: "Sample",
          active: false,
        },
      },
    });
    expect(activeTabId).toBe(77);
    await expect(
      service.handle({
        requestId: "spawn-send-1",
        method: "agent_send",
        params: {
          workspace: "space-a",
          agentId: "sample-sample-cli:10",
          message: "first task",
        },
      }),
    ).resolves.toMatchObject({ result: { ok: true } });
    expect(writes).toEqual([
      [101, "first task"],
      [101, "\r"],
    ]);
    service.dispose();
  });

  it("waits for the real Antigravity prompt after its login shell", async () => {
    vi.useFakeTimers();
    let tabs: Tab[] = [];
    let sessions: Record<number, AgentSession> = {};
    let buffer = "Antigravity CLI\nSigning in...\nPS C:\\work\\alpha>";
    const writes: Array<[number, string]> = [];
    const service = createAgentAutomationService({
      getTabs: () => tabs,
      getSpaces: () => [space()],
      getSessions: () => sessions,
      getActiveTabId: () => null,
      getBuffer: () => buffer,
      write: (leafId, data) => {
        writes.push([leafId, data]);
        return true;
      },
      spawn: (workspace, agent) => {
        tabs = [terminalTab({ title: "Antigravity" })];
        sessions = {
          101: session({
            agent: "antigravity",
            name: "Antigravity",
            status: "working",
            phase: "working",
          }),
        };
        return {
          agentId: agentIdFor(agent, agent, 10),
          cli: agent,
          tabId: 10,
          leafId: 101,
          spaceId: workspace.id,
          workspace: workspace.root,
        };
      },
      subscribeSessions: () => () => {},
    });

    await expect(
      service.handle({
        requestId: "spawn-antigravity",
        method: "agent_spawn",
        params: { workspace: "space-a", agent: "antigravity" },
      }),
    ).resolves.toMatchObject({ result: { ok: true, pending: false } });

    const pending = service.handle({
      requestId: "send-antigravity",
      method: "agent_send",
      params: {
        workspace: "space-a",
        agentId: "antigravity:10",
        message: "first Antigravity task",
        timeout: 5_000,
      },
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(writes).toEqual([]);

    buffer = "Antigravity CLI\n? for shortcuts\n>";
    await vi.advanceTimersByTimeAsync(1_100);
    await expect(pending).resolves.toMatchObject({ result: { ok: true } });
    expect(writes).toEqual([
      [101, "first Antigravity task"],
      [101, "\r"],
    ]);
    service.dispose();
  });

  it("reports an agent id that is not registered by the launcher", async () => {
    const spawn = vi.fn(() => null);
    const service = createAgentAutomationService({
      getTabs: () => [],
      getSpaces: () => [space()],
      getSessions: () => ({}),
      getActiveTabId: () => null,
      getBuffer: () => "",
      write: () => true,
      spawn,
      subscribeSessions: () => () => {},
    });

    await expect(
      service.handle({
        requestId: "spawn-2",
        method: "agent_spawn",
        params: { workspace: "space-a", agent: "unknown" },
      }),
    ).resolves.toMatchObject({ error: { code: "launch_failed" } });
    expect(spawn).toHaveBeenCalledWith(
      { id: "space-a", root: "C:/work/alpha" },
      "unknown",
    );
    service.dispose();
  });
});
