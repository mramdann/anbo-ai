import type { AgentSession } from "@/modules/agents/lib/types";
import type { SpaceMeta } from "@/modules/spaces/lib/store";
import type { Tab, TerminalTab } from "@/modules/tabs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentOutputTracker,
  agentIdFor,
  collectWorkspaceAgents,
  createAgentAutomationService,
  resolveAgentWorkspace,
  sanitizeAgentMessage,
} from "./agentAutomation";

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
        agentId: agentIdFor("space-a", 101),
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
      subscribeSessions: () => () => {},
    });
    const pending = service.handle({
      requestId: "request-1",
      method: "agent_send",
      params: {
        workspace: "C:/work/alpha",
        agentId: agentIdFor("space-a", 101),
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
        agentId: agentIdFor("space-a", 101),
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
});
