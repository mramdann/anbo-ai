import { describe, expect, it, vi } from "vitest";
import { AutomationPresence } from "./automationPresence";
import type { AutomationState } from "./automationState";

function event(
  controlId: number,
  tabId: number,
  sequence: number,
  phase: AutomationState["phase"] = "running",
  requestId = sequence,
): AutomationState {
  return {
    controlId,
    tabId,
    requestId,
    sequence,
    phase,
    method: "click",
    actor: { brand: "claude", label: "Claude", ptyId: controlId },
  };
}

describe("per-session browser indicators", () => {
  it("keeps two agents of the same CLI visible on different tabs", () => {
    const store = new AutomationPresence();
    store.receive(event(1, 10, 1));
    store.receive(event(2, 20, 2));
    expect(store.get(10).map((s) => s.controlId)).toEqual([1]);
    expect(store.get(20).map((s) => s.controlId)).toEqual([2]);
  });

  it("shows a queued caller beside the running caller, retaining both on handoff", () => {
    const store = new AutomationPresence();
    store.receive(event(1, 10, 1));
    store.receive(event(2, 10, 2, "queued"));
    expect(store.get(10).map((s) => s.phase)).toEqual(["running", "queued"]);
    store.receive(event(2, 10, 3, "running", 2));
    store.receive(event(1, 10, 4, "done", 1));
    expect(store.get(10).map((s) => s.phase)).toEqual(["done", "running"]);
    store.receive(event(2, 10, 5, "ended", 2));
    expect(store.get(10).map((s) => s.controlId)).toEqual([1]);
    store.receive(event(2, 10, 6, "done", 2));
    expect(store.get(10).map((s) => s.controlId)).toEqual([1]);
  });

  it("moves only that session and does not move it back on a late completion", () => {
    const store = new AutomationPresence();
    store.receive(event(1, 10, 1));
    store.receive(event(2, 10, 2));
    store.receive(event(1, 20, 3));
    store.receive(event(1, 10, 4, "done", 1));
    expect(store.get(10).map((s) => s.controlId)).toEqual([2]);
    expect(store.get(20).map((s) => s.controlId)).toEqual([1]);
    store.receive(event(1, 10, 5, "ended", 1));
    expect(store.get(20).map((s) => s.controlId)).toEqual([1]);
  });

  it("keeps anonymous callers distinct by session and preserves idle presence", () => {
    const store = new AutomationPresence();
    const anonymous = { brand: "remote", label: "Remote agent" };
    store.receive({ ...event(1, 10, 1, "done"), actor: anonymous });
    store.receive({ ...event(2, 10, 2, "done"), actor: anonymous });
    store.receive({ ...event(1, 10, 3, "idle", 1), actor: anonymous });
    expect(store.get(10)).toHaveLength(2);
    expect(store.get(10)[0].phase).toBe("idle");
    store.clear(10);
    expect(store.get(10)).toEqual([]);
  });

  it("notifies only affected tabs and returns stable snapshots for ignored events", () => {
    const store = new AutomationPresence();
    const first = vi.fn(),
      second = vi.fn();
    const unsubscribe = store.subscribe(10, first);
    store.subscribe(20, second);
    store.receive(event(1, 10, 1));
    const snapshot = store.get(10);
    store.receive(event(1, 10, 1));
    expect(store.get(10)).toBe(snapshot);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    store.receive(event(1, 20, 2));
    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledTimes(1);
    unsubscribe();
    store.clear(10);
    expect(first).toHaveBeenCalledTimes(2);
  });

  it("bounds live indicators through repeated control rotations", () => {
    const store = new AutomationPresence();
    for (let id = 1; id <= 1000; id++) store.receive(event(id, 10, id));
    expect(store.get(10)).toHaveLength(64);
    expect(store.get(10)[0].controlId).toBe(937);
  });
});
