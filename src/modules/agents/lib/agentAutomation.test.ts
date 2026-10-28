import type { AgentSession } from "@/modules/agents/lib/types";
import type { SpaceMeta } from "@/modules/spaces/lib/store";
import type { Tab, TerminalTab } from "@/modules/tabs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentScreens } from "./agentScreen.fixtures";
import {
  AgentOutputTracker,
  agentIdFor,
  collectWorkspaceAgents,
  createAgentAutomationService as createService,
  echoedLength,
  isAgentTuiReady,
  isTypedInput,
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

// A Claude composer at rest; tests that type into it append what Claude would
// draw of the text (it waits for that echo before pressing Enter).
const CLAUDE_READY = "Claude Code\nPress ? for shortcuts\n❯ ";

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
      unpreparedReason: () => "All 16 live terminal buffers are in use.",
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
    ).resolves.toMatchObject({
      error: {
        code: "agent_not_ready",
        message: expect.stringContaining(
          "terminal is not attached: All 16 live terminal buffers are in use.",
        ),
      },
    });
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

  it("takes a Codex resumed on a later day, whose turn row carries a date", () => {
    // Round 68 (R68-1): every agent_send to such a Codex timed out, because
    // the dated row did not end the turn and no rollout turn followed.
    const screen = agentScreens.codexResumedDated.join("\n");
    expect(isAgentTuiReady("codex", screen)).toBe(true);
    expect(
      isAgentTuiReady("codex", screen.replace(/^\s*Worked for .*$/m, "")),
    ).toBe(false);
  });

  it("takes a fresh Codex whose screen starts with a notice", () => {
    // Round 70 (R70-2): agent_send to a just-spawned Codex timed out after
    // 30 s because its "• You have 1 usage limit reset available." read as
    // an unfinished turn, and a session with no turn has no rollout yet.
    const screen = agentScreens.codexFreshNotice.join("\n");
    expect(isAgentTuiReady("codex", screen)).toBe(true);
    expect(
      isAgentTuiReady(
        "codex",
        screen.replace(
          "› Ask Codex",
          "› Baca app.js\n\n• Saya akan membaca app.js.\n\n› Ask Codex",
        ),
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

  it("lets a repainting prompt settle before pressing Enter", async () => {
    // Kimi reads a message too wide for one paste as a burst, and folds a
    // carriage return arriving inside that burst into the input box as a
    // newline rather than a send -- the message is then typed but never sent.
    // This box keeps repainting for a few frames after the last chunk lands,
    // so Enter has to wait them out.
    const repaintFrames = 6;
    const message = "a".repeat(300);
    const writes: string[] = [];
    let frames = 0;
    let framesAtEnter: number | null = null;
    const submitted = await submitAgentMessage(
      (_leafId, data) => {
        writes.push(data);
        if (data === "\r") framesAtEnter = frames;
        return true;
      },
      () => {
        frames += 1;
        const typed = writes.filter((data) => data !== "\r").join("");
        return frames < repaintFrames ? `${typed} frame ${frames}` : typed;
      },
      107,
      message,
      true,
    );

    expect(submitted).toBe(true);
    expect(writes.filter((data) => data !== "\r").join("")).toBe(message);
    expect(writes[writes.length - 1]).toBe("\r");
    expect(framesAtEnter).toBeGreaterThan(repaintFrames);
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
    // Enter follows the echo only once the prompt has held still.
    await vi.advanceTimersByTimeAsync(500);
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
    let buffer = CLAUDE_READY;
    const service = createAgentAutomationService({
      getTabs: () => [terminalTab()] as Tab[],
      getSpaces: () => [space()],
      getSessions: () => sessions,
      getActiveTabId: () => null,
      getBuffer: () => buffer,
      write: (leafId, data) => {
        writes.push([leafId, data]);
        if (data !== "\r") buffer += data;
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
    await vi.advanceTimersByTimeAsync(1_000);
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
    // Enter follows the echo only once the prompt has held still.
    await vi.advanceTimersByTimeAsync(500);
    await expect(pending).resolves.toMatchObject({ result: { ok: true } });
    expect(writes).toEqual([
      [101, "SPICA AGENT OK"],
      [101, "\r"],
    ]);
    service.dispose();
  });

  it("waits for Kimi to echo a short message before pressing Enter", async () => {
    // Not a first message and well under one paste, so this used to take the
    // fixed-delay path and hand Kimi an Enter it quietly swallowed: the
    // instruction stayed typed in the box while the sender believed it sent.
    vi.useFakeTimers();
    let buffer = "Welcome to Kimi Code!\ncontext: 0% (0/977k)\n> ";
    const writes: Array<[number, string]> = [];
    const service = createAgentAutomationService({
      getTabs: () => [terminalTab()] as Tab[],
      getSpaces: () => [space()],
      getSessions: () => ({
        101: session({ agent: "kimi", name: "Atlas" }),
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
      requestId: "request-kimi",
      method: "agent_send",
      params: {
        workspace: "space-a",
        agentId: "atlas-kimi:10",
        message: "Sebutkan satu warna saja.",
      },
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(writes).toEqual([[101, "Sebutkan satu warna saja."]]);

    buffer += "Sebutkansatuwarnasaja.";
    await vi.advanceTimersByTimeAsync(500);
    await expect(pending).resolves.toMatchObject({ result: { ok: true } });
    expect(writes).toEqual([
      [101, "Sebutkan satu warna saja."],
      [101, "\r"],
    ]);
    service.dispose();
  });

  it("waits for Claude to echo a short message before pressing Enter", async () => {
    // A Claude still loading the session it resumed read the text and an
    // Enter 90 ms later in one go: the Enter became a newline in its box, the
    // question stayed typed but unsent, and later messages joined it there.
    vi.useFakeTimers();
    let buffer = CLAUDE_READY;
    const writes: Array<[number, string]> = [];
    const service = createAgentAutomationService({
      getTabs: () => [terminalTab()] as Tab[],
      getSpaces: () => [space()],
      getSessions: () => ({ 101: session() }),
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
      requestId: "request-claude",
      method: "agent_send",
      params: {
        workspace: "space-a",
        agentId: "atlas-claude:10",
        message: "Which word did I ask you to remember?",
      },
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(writes).toEqual([[101, "Which word did I ask you to remember?"]]);

    buffer += "Which word did I ask you to remember?";
    await vi.advanceTimersByTimeAsync(500);
    await expect(pending).resolves.toMatchObject({ result: { ok: true } });
    expect(writes).toEqual([
      [101, "Which word did I ask you to remember?"],
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
    // No wait for the agent to finish, only for what it draws of the text.
    let buffer = CLAUDE_READY;
    const service = createAgentAutomationService({
      getTabs: () => [terminalTab()] as Tab[],
      getSpaces: () => [space()],
      getSessions: () => ({
        101: session({ status: "working", phase: "working" }),
      }),
      getActiveTabId: () => null,
      getBuffer: () => buffer,
      write: (leafId, data) => {
        writes.push([leafId, data]);
        if (data !== "\r") buffer += data;
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
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toMatchObject({ result: { ok: true } });
    expect(writes).toEqual([
      [101, "inspect the workspace"],
      [101, "\r"],
    ]);
    service.dispose();
  });

  it("types no message once the caller has stopped waiting", async () => {
    vi.useFakeTimers();
    const writes: Array<[number, string]> = [];
    let buffer = CLAUDE_READY;
    const service = createAgentAutomationService({
      getTabs: () => [terminalTab()] as Tab[],
      getSpaces: () => [space()],
      getSessions: () => ({
        101: session({ status: "working", phase: "working" }),
      }),
      getActiveTabId: () => null,
      getBuffer: () => buffer,
      write: (leafId, data) => {
        writes.push([leafId, data]);
        if (data !== "\r") buffer += data;
        return true;
      },
      spawn: () => null,
      subscribeSessions: () => () => {},
    });
    const send = (deadline: number) =>
      service.handle({
        requestId: `request-${deadline}`,
        method: "agent_send",
        params: {
          workspace: "space-a",
          agentId: "atlas-claude:10",
          message: "inspect the workspace",
          waitForReady: false,
        },
        deadline,
      });
    await expect(send(Date.now() - 1)).resolves.toMatchObject({
      error: { code: "timeout" },
    });
    expect(writes).toEqual([]);
    const inTime = send(Date.now() + 5_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(inTime).resolves.toMatchObject({ result: { ok: true } });
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
    let buffer = CLAUDE_READY;
    const writes: string[] = [];
    const service = createAgentAutomationService({
      getTabs: () => [terminalTab()] as Tab[],
      getSpaces: () => [space()],
      getSessions: () => ({ 101: session() }),
      getActiveTabId: () => null,
      getBuffer: () => buffer,
      write: (_leafId, data) => {
        writes.push(data);
        if (data !== "\r") {
          // Claude draws the typed text at once.
          buffer += data;
        } else if (writes.length === 2) {
          // The first message's fast turn: its answer and a fresh prompt.
          setTimeout(() => {
            buffer += "\nanswer\n\u276f ";
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
    await vi.advanceTimersByTimeAsync(1_000);
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
    await vi.advanceTimersByTimeAsync(1_000);
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

const CODEX_READY =
  "OpenAI Codex\nmodel: gpt-5.6-sol /model to change\n\n› Ask Codex to do anything";

/**
 * A Codex terminal starved of CPU: it shows what it is sent a few characters a
 * tick and reports every input the way a terminal session does. Enter empties
 * its input box, and the turn's answer shows a moment later.
 */
function starvedCodex(charsPerTick: number, tickMs: number) {
  const writes: string[] = [];
  const listeners = new Set<(leafId: number, data: string) => void>();
  let shown = "";
  let unread = "";
  let answers = 0;
  let taking = true;
  const ticker = setInterval(() => {
    if (!taking) return;
    shown += unread.slice(0, charsPerTick);
    unread = unread.slice(charsPerTick);
  }, tickMs);
  return {
    writes,
    getBuffer: () => `${"Answered.\n".repeat(answers)}${CODEX_READY}\n${shown}`,
    write: (leafId: number, data: string) => {
      writes.push(data);
      for (const listener of listeners) listener(leafId, data);
      if (data === "\r") {
        shown = "";
        setTimeout(() => {
          answers += 1;
        }, 300);
      } else if (data === "\x03") {
        shown = "";
        unread = "";
      } else {
        unread += data;
      }
      return true;
    },
    subscribeInput: (listener: (leafId: number, data: string) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    typeByHand: (data: string) => {
      for (const listener of listeners) listener(101, data);
    },
    stopTaking: () => {
      taking = false;
    },
    dispose: () => clearInterval(ticker),
  };
}

const starvedCodexService = (terminal: ReturnType<typeof starvedCodex>) =>
  createAgentAutomationService({
    getTabs: () => [terminalTab()] as Tab[],
    getSpaces: () => [space()],
    getSessions: () => ({ 101: session({ agent: "codex", name: "Spica" }) }),
    getActiveTabId: () => null,
    getBuffer: terminal.getBuffer,
    write: terminal.write,
    subscribeInput: terminal.subscribeInput,
    spawn: () => null,
    subscribeSessions: () => () => {},
  });

// Every 120-character stretch of this is unique, as a real instruction's is.
const numberedSteps = (count: number) =>
  Array.from(
    { length: count },
    (_, index) =>
      `Langkah ${index + 1}: catat harga barang nomor ${index * 37 + 11}.`,
  ).join(" ");

describe("agent messages a CPU-starved CLI takes in slowly", () => {
  it("measures how much of a message a screen shows", () => {
    const typed =
      "Langkah1:catathargabarangnomor11.Langkah2:catathargabarangnomor48.";
    expect(echoedLength(`›${typed.slice(0, 40)}`, typed, 0)).toBe(40);
    expect(echoedLength(`›${typed}`, typed, 10)).toBe(typed.length);
    // Too short to tell apart from other text on the screen.
    expect(echoedLength(`›${typed.slice(0, 8)}`, typed, 0)).toBe(0);
    // An echo only grows.
    expect(echoedLength("›", typed, 30)).toBe(30);
  });

  it("tells keys someone typed from what a terminal sends by itself", () => {
    for (const report of [
      "\x1b[I",
      "\x1b[O",
      "\x1b[<64;10;5M",
      "\x1b[12;40R",
      "\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\",
      "\x1bP>|xterm.js(6.0.0)\x1b\\",
      "\x1bOA",
    ]) {
      expect(isTypedInput(report)).toBe(false);
    }
    for (const typed of [
      "x",
      "\r",
      "\x7f",
      "\x03",
      "\x1b",
      "\x1b[200~halo\x1b[201~",
    ]) {
      expect(isTypedInput(typed)).toBe(true);
    }
  });

  it("keeps typing a message the agent still takes in when the answer is due", async () => {
    vi.useFakeTimers();
    const terminal = starvedCodex(10, 200);
    const service = starvedCodexService(terminal);
    const message = numberedSteps(18);
    const pending = service.handle({
      requestId: "starved",
      method: "agent_send",
      params: {
        workspace: "space-a",
        agentId: "spica-codex:10",
        message,
        timeout: 2_000,
      },
    });
    await vi.advanceTimersByTimeAsync(2_500);
    await expect(pending).resolves.toMatchObject({
      result: { ok: true, delivery: "typing" },
    });
    expect(terminal.writes).toEqual([message.slice(0, 256)]);
    // A focus report from the terminal is not someone typing.
    terminal.typeByHand("\x1b[I");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(terminal.writes.slice(0, -1).join("")).toBe(message);
    expect(terminal.writes[terminal.writes.length - 1]).toBe("\r");
    expect(terminal.writes).not.toContain("\x03");
    terminal.dispose();
    service.dispose();
  });

  it("clears a message once its agent takes no more of it for 30 s", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const terminal = starvedCodex(10, 200);
    const service = starvedCodexService(terminal);
    const message = numberedSteps(18);
    const pending = service.handle({
      requestId: "stalled",
      method: "agent_send",
      params: {
        workspace: "space-a",
        agentId: "spica-codex:10",
        message,
        timeout: 2_000,
      },
    });
    await vi.advanceTimersByTimeAsync(2_500);
    await expect(pending).resolves.toMatchObject({
      result: { delivery: "typing" },
    });
    terminal.stopTaking();
    await vi.advanceTimersByTimeAsync(29_000);
    expect(terminal.writes).toEqual([message.slice(0, 256)]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(terminal.writes).toEqual([message.slice(0, 256), "\x03"]);
    expect(warn).toHaveBeenCalledWith(
      "[anbo] agent_send:",
      expect.stringContaining("showed no more of the message for 30 s"),
    );
    warn.mockRestore();
    terminal.dispose();
    service.dispose();
  });

  it("waits the caller's whole timeout before giving up a message that never shows, not the 30 s stall", async () => {
    // A CLI whose TUI repaints nothing under load (Claude Code goes quiet)
    // shows no progress at all. The 30 s no-progress stall is for background
    // typing only, so within a 40 s wait nothing is cancelled until 40 s.
    vi.useFakeTimers();
    const writes: string[] = [];
    const service = createAgentAutomationService({
      getTabs: () => [terminalTab()] as Tab[],
      getSpaces: () => [space()],
      getSessions: () => ({ 101: session({ agent: "codex", name: "Spica" }) }),
      getActiveTabId: () => null,
      // A ready prompt that never echoes anything typed into it.
      getBuffer: () => CODEX_READY,
      write: (_leafId, data) => {
        writes.push(data);
        return true;
      },
      spawn: () => null,
      subscribeSessions: () => () => {},
    });
    const pending = service.handle({
      requestId: "quiet-tui",
      method: "agent_send",
      params: {
        workspace: "space-a",
        agentId: "spica-codex:10",
        message: numberedSteps(6),
        timeout: 40_000,
      },
    });
    // At 35 s, past the stall but inside the caller's wait: still typing, the
    // first chunk written, no Ctrl+C, no answer yet.
    await vi.advanceTimersByTimeAsync(35_000);
    expect(writes).toEqual([numberedSteps(6).slice(0, 256)]);
    await vi.advanceTimersByTimeAsync(6_000);
    await expect(pending).resolves.toMatchObject({
      error: {
        code: "agent_not_ready",
        message: expect.stringContaining("none of the message showed"),
      },
    });
    expect(writes).toEqual([numberedSteps(6).slice(0, 256), "\x03"]);
    service.dispose();
  });

  it("holds the next message to that agent until the one being typed is sent", async () => {
    vi.useFakeTimers();
    const terminal = starvedCodex(10, 200);
    const service = starvedCodexService(terminal);
    const send = (agentId: string, message: string, timeout: number) =>
      service.handle({
        requestId: `${agentId}-${message.length}`,
        method: "agent_send",
        params: { workspace: "space-a", agentId, message, timeout },
      });
    const first = numberedSteps(18);
    const second = "Lalu kirim ringkasannya.";
    const firstSent = send("spica-codex:10", first, 2_000);
    await vi.advanceTimersByTimeAsync(2_500);
    await expect(firstSent).resolves.toMatchObject({
      result: { delivery: "typing" },
    });
    // Sending it again would deliver it twice.
    await expect(send("spica-codex:10", first, 2_000)).resolves.toMatchObject({
      result: { delivery: "typing" },
    });
    // The callsign names the same terminal, so it waits its turn too.
    const secondSent = send("Spica", second, 20_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(terminal.writes).not.toContain(second);
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(secondSent).resolves.toMatchObject({
      result: { ok: true, delivery: "submitted" },
    });
    expect(terminal.writes.slice(0, -3).join("")).toBe(first);
    expect(terminal.writes.slice(-3)).toEqual(["\r", second, "\r"]);
    terminal.dispose();
    service.dispose();
  });

  it("tells a send its turn did not come in time, and never types it later", async () => {
    vi.useFakeTimers();
    const terminal = starvedCodex(10, 200);
    const service = starvedCodexService(terminal);
    const send = (message: string, timeout: number) =>
      service.handle({
        requestId: `late-${message.length}`,
        method: "agent_send",
        params: {
          workspace: "space-a",
          agentId: "spica-codex:10",
          message,
          timeout,
        },
      });
    const first = numberedSteps(18);
    const late = "Pesan yang menunggu terlalu lama.";
    const firstSent = send(first, 2_000);
    await vi.advanceTimersByTimeAsync(2_500);
    await expect(firstSent).resolves.toMatchObject({
      result: { delivery: "typing" },
    });
    const lateSent = send(late, 1_000);
    await vi.advanceTimersByTimeAsync(1_100);
    await expect(lateSent).resolves.toMatchObject({
      error: {
        code: "timeout",
        message: expect.stringContaining("earlier message to Spica"),
      },
    });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(terminal.writes).not.toContain(late);
    expect(terminal.writes[terminal.writes.length - 1]).toBe("\r");
    terminal.dispose();
    service.dispose();
  });

  it("stops typing, without Ctrl+C or Enter, once someone types in the terminal", async () => {
    vi.useFakeTimers();
    const terminal = starvedCodex(10, 200);
    const service = starvedCodexService(terminal);
    const message = numberedSteps(18);
    const pending = service.handle({
      requestId: "typed-over",
      method: "agent_send",
      params: {
        workspace: "space-a",
        agentId: "spica-codex:10",
        message,
        timeout: 30_000,
      },
    });
    await vi.advanceTimersByTimeAsync(6_000);
    expect(terminal.writes).toEqual([
      message.slice(0, 256),
      message.slice(256, 512),
    ]);
    terminal.typeByHand("halo");
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toMatchObject({
      error: {
        code: "agent_not_ready",
        message: expect.stringContaining("someone typed in its terminal"),
      },
    });
    expect(terminal.writes).toHaveLength(2);
    terminal.dispose();
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

  it("keeps answering to the id a custom agent was spawned with after it gets a callsign", async () => {
    let sessions: Record<number, AgentSession> = {};
    const writes: Array<[number, string]> = [];
    const service = createAgentAutomationService({
      getTabs: () => [terminalTab({ title: "ClaudeZ" })],
      getSpaces: () => [space()],
      getSessions: () => sessions,
      getActiveTabId: () => null,
      getBuffer: () => writes.map(([, data]) => data).join(""),
      write: (leafId, data) => {
        writes.push([leafId, data]);
        return true;
      },
      spawn: (workspace, agent) => {
        sessions = {
          101: session({
            agent: "claude",
            name: "ClaudeZ",
            status: "working",
            phase: "working",
          }),
        };
        return {
          agentId: agentIdFor(agent, agent, 10),
          cli: "claude",
          tabId: 10,
          leafId: 101,
          spaceId: workspace.id,
          workspace: workspace.root,
        };
      },
      subscribeSessions: () => () => {},
    });
    const spawned = await service.handle({
      requestId: "spawn-claudez",
      method: "agent_spawn",
      params: { workspace: "space-a", agent: "custom:claudez", timeout: 100 },
    });
    expect(spawned).toMatchObject({
      result: { agent: { agentId: "claudez-claude:10" } },
    });
    sessions = {
      101: {
        ...sessions[101],
        name: "Jasper",
        status: "waiting",
        phase: "finished",
      },
    };
    await expect(
      service.handle({
        requestId: "send-claudez",
        method: "agent_send",
        params: {
          workspace: "space-a",
          agentId: "claudez-claude:10",
          message: "next task",
          waitForReady: false,
        },
      }),
    ).resolves.toMatchObject({ result: { ok: true } });
    expect(writes[0]).toEqual([101, "next task"]);
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

describe("restored agents that have not resumed", () => {
  const restoredTab = (cold: boolean) =>
    terminalTab({
      cold,
      agent: {
        launcherId: "claude",
        icon: "claude",
        label: "Claude",
        name: "Atlas",
      },
      paneTree: {
        kind: "leaf",
        id: 101,
        agentResume: {
          agent: "claude",
          command: "claude",
          sessionId: "00000000-0000-4000-8000-000000000001",
          resumeOnStart: true,
        },
      },
    });

  it("lists a restored agent of a workspace not shown yet under the id it resumes with", () => {
    // Measured: after a restart agent_list found no agent in two hidden
    // workspaces, and the orchestrator started a second agent in each.
    const agents = collectWorkspaceAgents(
      [restoredTab(true)],
      {},
      { id: "space-a", root: "C:/work/alpha" },
      null,
    );
    expect(agents).toEqual([
      expect.objectContaining({
        agentId: "atlas-claude:10",
        name: "Atlas",
        cli: "claude",
        status: "dormant",
        sessionId: "00000000-0000-4000-8000-000000000001",
      }),
    ]);
    expect(
      collectWorkspaceAgents(
        [restoredTab(false)],
        {},
        { id: "space-a", root: "C:/work/alpha" },
        null,
        { 101: "resuming" },
      ),
    ).toEqual([expect.objectContaining({ status: "resuming" })]);
    // Once its CLI is back the live session speaks for it; after it exits, or
    // when its resume was refused, it is not listed.
    expect(
      collectWorkspaceAgents(
        [restoredTab(false)],
        { 101: session() },
        { id: "space-a", root: "C:/work/alpha" },
        null,
        { 101: "resuming" },
      ),
    ).toEqual([expect.objectContaining({ status: "waiting" })]);
    const notResuming: Record<number, "failed">[] = [{}, { 101: "failed" }];
    for (const resumeStatus of notResuming) {
      expect(
        collectWorkspaceAgents(
          [restoredTab(false)],
          {},
          { id: "space-a", root: "C:/work/alpha" },
          null,
          resumeStatus,
        ),
      ).toEqual([]);
    }
  });

  it("waits on a dormant agent through its resume", async () => {
    let tabs = [restoredTab(true)];
    let sessions: Record<number, AgentSession> = {};
    const listeners = new Set<() => void>();
    const warm = vi.fn(() => {
      setTimeout(() => {
        tabs = [restoredTab(false)];
      }, 10);
      setTimeout(() => {
        sessions = { 101: session({ status: "waiting", phase: "attention" }) };
        for (const listener of listeners) listener();
      }, 40);
    });
    const service = createAgentAutomationService({
      getTabs: () => tabs,
      getSpaces: () => [space()],
      getSessions: () => sessions,
      getActiveTabId: () => null,
      getBuffer: () => null,
      write: () => true,
      spawn: () => null,
      subscribeSessions: (listener) => {
        const wrapped = () => listener(sessions, {});
        listeners.add(wrapped);
        return () => listeners.delete(wrapped);
      },
      warm,
      getResumeStatus: () => ({ 101: "resuming" }),
    });
    await expect(
      service.handle({
        requestId: "wait",
        method: "agent_wait",
        params: {
          workspace: "space-a",
          agentId: "atlas-claude:10",
          timeout: 2_000,
        },
      }),
    ).resolves.toMatchObject({
      result: {
        matched: true,
        closed: false,
        agent: { agentId: "atlas-claude:10", status: "waiting" },
      },
    });
    expect(warm).toHaveBeenCalledWith(10);
    service.dispose();
  });

  it("resumes a dormant agent a tool acts on, and only reports it to agent_status", async () => {
    const warm = vi.fn();
    const write = vi.fn(() => true);
    const service = createAgentAutomationService({
      getTabs: () => [restoredTab(true)],
      getSpaces: () => [space()],
      getSessions: () => ({}),
      getActiveTabId: () => null,
      getBuffer: () => null,
      write,
      spawn: () => null,
      subscribeSessions: () => () => {},
      warm,
    });
    await expect(
      service.handle({
        requestId: "status",
        method: "agent_status",
        params: { workspace: "space-a", agentId: "atlas-claude:10" },
      }),
    ).resolves.toMatchObject({ result: { agent: { status: "dormant" } } });
    expect(warm).not.toHaveBeenCalled();
    await expect(
      service.handle({
        requestId: "send",
        method: "agent_send",
        params: {
          workspace: "space-a",
          agentId: "atlas-claude:10",
          message: "continue",
        },
      }),
    ).resolves.toMatchObject({
      error: {
        code: "agent_unavailable",
        message: expect.stringContaining("Anbo is resuming it now"),
      },
    });
    expect(warm).toHaveBeenCalledWith(10);
    expect(write).not.toHaveBeenCalled();
    service.dispose();
  });
});

describe("reading an agent whose turn just ended", () => {
  it("waits for the screen to catch up with the status", async () => {
    // Measured: agent_read right after agent_wait matched "waiting" returned
    // the old "Working (3s ..." screen.
    let screen = "Working (3s · esc to interrupt)";
    setTimeout(() => {
      screen = "Done: 3 files checked\nPress ? for shortcuts";
    }, 30);
    const service = createAgentAutomationService({
      getTabs: () => [terminalTab()],
      getSpaces: () => [space()],
      getSessions: () => ({
        101: session({ status: "waiting", lastActivityAt: Date.now() }),
      }),
      getActiveTabId: () => null,
      getBuffer: () => screen,
      write: () => true,
      spawn: () => null,
      subscribeSessions: () => () => {},
    });
    const read = await service.handle({
      requestId: "read",
      method: "agent_read",
      params: { workspace: "space-a", agentId: "atlas-claude:10" },
    });
    expect((read.result as { output: string }).output).toContain(
      "Done: 3 files checked",
    );
    service.dispose();
  });
});

describe("agents agent_spawn starts", () => {
  const handle = {
    agentId: "codex:12",
    cli: "codex",
    tabId: 12,
    leafId: 121,
    spaceId: "space-a",
    workspace: "C:/work/alpha",
    activated: false,
  };
  const spawnedTab = () =>
    terminalTab({
      id: 12,
      paneTree: { kind: "leaf", id: 121 },
      activeLeafId: 121,
    });

  it("answers a spawn whose shell could not start instead of a pending agent forever", async () => {
    // Measured: under memory pressure agent_spawn answered pending for codex
    // agents whose shells the resource guard refused; they never appeared.
    const discardSpawn = vi.fn();
    const service = createAgentAutomationService({
      getTabs: () => [spawnedTab()],
      getSpaces: () => [space()],
      getSessions: () => ({}),
      getActiveTabId: () => null,
      getBuffer: () => null,
      write: () => true,
      spawn: () => handle,
      subscribeSessions: () => () => {},
      getShellState: () => ({
        spawnFailed: true,
        spawnError: "resource_exhausted: Not enough system memory",
      }),
      discardSpawn,
    });
    await expect(
      service.handle({
        requestId: "spawn",
        method: "agent_spawn",
        params: { workspace: "space-a", agent: "codex", timeout: 2_000 },
      }),
    ).resolves.toMatchObject({
      error: {
        code: "resource_exhausted",
        message: expect.stringContaining(
          "shell could not start: resource_exhausted",
        ),
      },
    });
    expect(discardSpawn).toHaveBeenCalledWith(12);
    service.dispose();
  });

  it("answers a spawn whose terminal closed before its CLI started", async () => {
    let tabs = [spawnedTab()];
    setTimeout(() => {
      tabs = [];
    }, 30);
    const service = createAgentAutomationService({
      getTabs: () => tabs,
      getSpaces: () => [space()],
      getSessions: () => ({}),
      getActiveTabId: () => null,
      getBuffer: () => null,
      write: () => true,
      spawn: () => handle,
      subscribeSessions: () => () => {},
      getShellState: () => null,
    });
    await expect(
      service.handle({
        requestId: "spawn",
        method: "agent_spawn",
        params: { workspace: "space-a", agent: "codex", timeout: 2_000 },
      }),
    ).resolves.toMatchObject({
      error: {
        code: "launch_failed",
        message: expect.stringContaining("closed before its CLI started"),
      },
    });
    service.dispose();
  });

  it("hands the spawned terminal to the terminal tools as the spawner's own", async () => {
    // Measured: helper agents that exited left their tab and a live shell
    // that no tool of the agent that spawned them could close.
    const openedTerminals = new Set<string>();
    const spawnedTerminals = new Map<string, boolean>();
    const service = createAgentAutomationService({
      getTabs: () => [spawnedTab()],
      getSpaces: () => [space()],
      getSessions: () => ({
        121: session({ leafId: 121, tabId: 12, agent: "codex", name: "Codex" }),
      }),
      getActiveTabId: () => null,
      getBuffer: () => null,
      write: () => true,
      spawn: () => handle,
      subscribeSessions: () => () => {},
      openedTerminals,
      spawnedTerminals,
    });
    await expect(
      service.handle({
        requestId: "spawn",
        method: "agent_spawn",
        params: { workspace: "space-a", agent: "codex" },
      }),
    ).resolves.toMatchObject({ result: { ok: true, pending: false } });
    expect([...openedTerminals]).toEqual(["terminal:12:121"]);
    // Its agent was seen running, so the terminal tools leave it alone until
    // that agent has ended (round 64, R64-2).
    expect([...spawnedTerminals]).toEqual([["terminal:12:121", true]]);
    service.dispose();
  });
});

describe("a question the agent puts up while a message goes in", () => {
  it("does not press Enter on it", async () => {
    // Measured: Codex drew its folder trust prompt 2 s after it started and
    // took a message sent at once; Enter on Claude 2.1.303's trust prompt
    // picks "No, exit".
    let typed = "";
    const writes: string[] = [];
    const dialog = [
      "Quick safety check: Is this a project you created or one you trust?",
      "❯ 1. No, exit",
      "  2. Yes, I trust this folder",
      "Enter to confirm · Esc to cancel",
    ].join("\n");
    const service = createAgentAutomationService({
      getTabs: () => [terminalTab()],
      getSpaces: () => [space()],
      getSessions: () => ({ 101: session() }),
      getActiveTabId: () => null,
      getBuffer: () => `${CLAUDE_READY}${typed}`,
      getScreen: () => (typed ? dialog : CLAUDE_READY),
      write: (_leafId, data) => {
        writes.push(data);
        if (data !== "\r") typed += data;
        return true;
      },
      spawn: () => null,
      subscribeSessions: () => () => {},
    });
    const sent = await service.handle({
      requestId: "send",
      method: "agent_send",
      params: {
        workspace: "space-a",
        agentId: "atlas-claude:10",
        message: "continue the task",
      },
    });
    expect(sent).toMatchObject({
      error: { message: expect.stringContaining("did not press Enter") },
    });
    expect(writes).not.toContain("\r");
    service.dispose();
  });
});

describe("a spawned tab the UI lists only after the spawn answered", () => {
  it("is waited for, not taken as closed", async () => {
    // Measured in Dev: the first look found no tab yet, answered "closed
    // before its CLI started" in 29 ms and closed the new tab.
    const discardSpawn = vi.fn();
    let tabs: ReturnType<typeof terminalTab>[] = [];
    let sessions: Record<number, ReturnType<typeof session>> = {};
    setTimeout(() => {
      tabs = [
        terminalTab({
          id: 12,
          paneTree: { kind: "leaf", id: 121 },
          activeLeafId: 121,
        }),
      ];
    }, 40);
    setTimeout(() => {
      sessions = {
        121: session({ leafId: 121, tabId: 12, agent: "codex", name: "Codex" }),
      };
    }, 400);
    const service = createAgentAutomationService({
      getTabs: () => tabs,
      getSpaces: () => [space()],
      getSessions: () => sessions,
      getActiveTabId: () => null,
      getBuffer: () => null,
      write: () => true,
      spawn: () => ({
        agentId: "codex:12",
        cli: "codex",
        tabId: 12,
        leafId: 121,
        spaceId: "space-a",
        workspace: "C:/work/alpha",
        activated: false,
      }),
      subscribeSessions: () => () => {},
      getShellState: () => null,
      discardSpawn,
    });
    await expect(
      service.handle({
        requestId: "spawn",
        method: "agent_spawn",
        params: { workspace: "space-a", agent: "codex", timeout: 3_000 },
      }),
    ).resolves.toMatchObject({ result: { ok: true, pending: false } });
    expect(discardSpawn).not.toHaveBeenCalled();
    service.dispose();
  });
});

describe("a send to an agent that shows a question of its own", () => {
  it("says so instead of a bare timeout", async () => {
    const service = createAgentAutomationService({
      getTabs: () => [terminalTab()],
      getSpaces: () => [space()],
      getSessions: () => ({ 101: session() }),
      getActiveTabId: () => null,
      getBuffer: () => null,
      getScreen: () =>
        [
          " Claude Code'll be able to read, edit, and execute files here.",
          "",
          " ❯ No, exit",
          "   Yes, I trust this folder",
          "",
          " Enter to confirm · Esc to cancel",
        ].join("\n"),
      write: () => true,
      spawn: () => null,
      subscribeSessions: () => () => {},
    });
    await expect(
      service.handle({
        requestId: "send",
        method: "agent_send",
        params: {
          workspace: "space-a",
          agentId: "atlas-claude:10",
          message: "continue the task",
          timeout: 300,
        },
      }),
    ).resolves.toMatchObject({
      error: {
        code: "agent_not_ready",
        message: expect.stringContaining("question of its own"),
      },
    });
    service.dispose();
  });
});
