import type { PaneNode } from "@/modules/terminal/lib/panes";
import { beforeEach, describe, expect, it } from "vitest";
import { shouldWarmAgentTabOnReopen } from "../lib/resume";
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

/**
 * End-to-end (logic-level) reproduction of the prod scenario: many workspaces,
 * the app closed and reopened. Exercises the real warm rule + the real status
 * store together — the closest to the live close/reopen without a desktop GUI.
 */
describe("lazy resume-on-reopen flow", () => {
  beforeEach(() => useAgentResumeStatus.setState({ status: {} }));
  const agentPane = (id: number): PaneNode => ({
    kind: "leaf",
    id,
    agentResume: { agent: "claude", command: "claude", resumeOnStart: true },
  });
  const coldTab = (id: number, spaceId: string) => ({
    kind: "terminal",
    cold: true,
    spaceId,
    paneTree: agentPane(id),
  });

  it("on reopen only the active workspace warms; background stays cold", () => {
    const tabs = [coldTab(1, "A"), coldTab(2, "B"), coldTab(3, "B")];
    const warmed = tabs
      .filter((t) => shouldWarmAgentTabOnReopen(t, "A"))
      .map((t) => t.paneTree.id);
    expect(warmed).toEqual([1]);
  });

  it("walks warm → resuming → (agent up) → clear for the active workspace", () => {
    const active = coldTab(1, "A");
    expect(shouldWarmAgentTabOnReopen(active, "A")).toBe(true); // warmed
    useAgentResumeStatus.getState().setStatus(1, "resuming"); // resume kicked off
    expect(tabResumePhase(useAgentResumeStatus.getState().status, [1])).toBe(
      "resuming",
    );
    useAgentResumeStatus.getState().clear(1); // TabIcon clears once the agent shows activity
    expect(
      tabResumePhase(useAgentResumeStatus.getState().status, [1]),
    ).toBeNull();
  });

  it("surfaces a red 'failed' badge when the resource guard refuses", () => {
    useAgentResumeStatus.getState().setStatus(1, "failed");
    expect(tabResumePhase(useAgentResumeStatus.getState().status, [1])).toBe(
      "failed",
    );
  });

  it("resumes a background workspace only once the user opens it, others keep running", () => {
    const tabs = [coldTab(1, "A"), coldTab(2, "B")];
    // reopen with A active: only A warms + resumes
    expect(shouldWarmAgentTabOnReopen(tabs[0], "A")).toBe(true);
    expect(shouldWarmAgentTabOnReopen(tabs[1], "A")).toBe(false);
    useAgentResumeStatus.getState().setStatus(1, "resuming");
    useAgentResumeStatus.getState().clear(1); // A's agent is up and running
    // user later switches to B → B warms + resumes; A is untouched (still running)
    expect(shouldWarmAgentTabOnReopen(tabs[1], "B")).toBe(true);
    useAgentResumeStatus.getState().setStatus(2, "resuming");
    const status = useAgentResumeStatus.getState().status;
    expect(tabResumePhase(status, [1])).toBeNull(); // A running, no spinner
    expect(tabResumePhase(status, [2])).toBe("resuming"); // B coming back
  });
});
