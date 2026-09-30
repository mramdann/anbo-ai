import { beforeEach, describe, expect, it } from "vitest";
import { nextAttentionTarget, useAgentStore } from "./agentStore";

describe("agent status detail", () => {
  beforeEach(() => {
    useAgentStore.setState({ sessions: {}, notifications: [] });
    useAgentStore.getState().start(1, 10, "claude", "Leander");
  });

  it("keeps the turn start and background work with the status", () => {
    const store = useAgentStore.getState();
    store.setStatus(1, "working", "working", { turnStartedAt: 5_000 });
    expect(useAgentStore.getState().sessions[1]).toMatchObject({
      status: "working",
      turnStartedAt: 5_000,
      background: null,
    });
    store.setStatus(1, "waiting", "finished", {
      turnStartedAt: null,
      background: "1 shell",
    });
    expect(useAgentStore.getState().sessions[1]).toMatchObject({
      status: "waiting",
      turnStartedAt: null,
      background: "1 shell",
    });
  });

  it("changes nothing for a repeated status with the same detail", () => {
    const store = useAgentStore.getState();
    store.setStatus(1, "waiting", "finished", { background: "1 task" });
    const before = useAgentStore.getState().sessions;
    store.setStatus(1, "waiting", "finished", { background: "1 task" });
    expect(useAgentStore.getState().sessions).toBe(before);
  });

  it("updates background work without resetting when the agent started waiting", () => {
    const store = useAgentStore.getState();
    store.setStatus(1, "waiting", "finished");
    const since = useAgentStore.getState().sessions[1].attentionSince;
    store.setStatus(1, "waiting", "finished", { background: "1 task" });
    const session = useAgentStore.getState().sessions[1];
    expect(session.background).toBe("1 task");
    expect(session.attentionSince).toBe(since);
  });
});

describe("nextAttentionTarget", () => {
  beforeEach(() => {
    useAgentStore.setState({ sessions: {}, notifications: [] });
  });

  it("goes to an agent blocked at a prompt before one that finished later", () => {
    const store = useAgentStore.getState();
    store.start(1, 10, "claude", "Leander");
    store.start(2, 20, "codex", "Mizar");
    useAgentStore.setState((state) => ({
      sessions: {
        1: {
          ...state.sessions[1],
          status: "waiting",
          phase: "attention",
          attentionSince: 1_000,
        },
        2: {
          ...state.sessions[2],
          status: "waiting",
          phase: "finished",
          attentionSince: 2_000,
        },
      },
    }));
    expect(nextAttentionTarget()).toEqual({ tabId: 10, leafId: 1 });
  });
});
