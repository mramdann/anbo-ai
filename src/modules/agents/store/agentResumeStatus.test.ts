import { beforeEach, describe, expect, it } from "vitest";
import {
  type AgentResumePhase,
  tabResumePhase,
  useAgentResumeStatus,
} from "./agentResumeStatus";

describe("tabResumePhase", () => {
  it("returns null when no leaf has a phase", () => {
    expect(tabResumePhase({}, [1, 2, 3])).toBeNull();
    expect(tabResumePhase({ 9: "resuming" }, [1, 2])).toBeNull();
  });

  it("reports resuming when a leaf is resuming", () => {
    expect(tabResumePhase({ 2: "resuming" }, [1, 2, 3])).toBe("resuming");
  });

  it("lets failed win over resuming", () => {
    const status: Record<number, AgentResumePhase> = {
      1: "resuming",
      2: "failed",
    };
    expect(tabResumePhase(status, [1, 2])).toBe("failed");
    expect(tabResumePhase(status, [2, 1])).toBe("failed");
  });
});

describe("useAgentResumeStatus store", () => {
  beforeEach(() => useAgentResumeStatus.setState({ status: {} }));

  it("sets and clears a leaf's phase", () => {
    const store = useAgentResumeStatus.getState();
    store.setStatus(7, "resuming");
    expect(useAgentResumeStatus.getState().status[7]).toBe("resuming");
    store.setStatus(7, "failed");
    expect(useAgentResumeStatus.getState().status[7]).toBe("failed");
    store.clear(7);
    expect(useAgentResumeStatus.getState().status[7]).toBeUndefined();
  });

  it("keeps a stable object when the phase does not change", () => {
    const store = useAgentResumeStatus.getState();
    store.setStatus(3, "resuming");
    const first = useAgentResumeStatus.getState().status;
    store.setStatus(3, "resuming");
    expect(useAgentResumeStatus.getState().status).toBe(first);
  });

  it("no-ops clearing an absent leaf", () => {
    const before = useAgentResumeStatus.getState().status;
    useAgentResumeStatus.getState().clear(42);
    expect(useAgentResumeStatus.getState().status).toBe(before);
  });
});
