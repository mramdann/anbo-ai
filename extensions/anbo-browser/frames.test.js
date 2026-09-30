import { describe, expect, it, vi } from "vitest";
import { createFrameTransport } from "./frames.js";

function harness(tabId = 10) {
  const calls = vi.fn(async (source, method, params) => {
    if (method === "Page.getFrameTree") return { frameTree: { frame: source.sessionId ? { id: "child", parentId: "root" } : { id: "root" } } };
    if (method === "Page.createIsolatedWorld") return { executionContextId: 5 };
    if (method === "Runtime.evaluate" && !params.returnByValue) return { result: { objectId: "same-object" } };
    return { result: { value: source.sessionId ?? "root" } };
  });
  const changed = vi.fn();
  return { calls, changed, transport: createFrameTransport({ debugger: { sendCommand: calls } }, tabId, changed) };
}

describe("selected-tab child frames", () => {
  it("attaches only child iframe sessions and merges their frame trees", async () => {
    const state = harness();
    await state.transport.start();
    state.transport.event({ tabId: 10 }, "Target.attachedToTarget", { sessionId: "child-session", targetInfo: { type: "iframe" } });
    state.transport.event({ tabId: 10 }, "Target.attachedToTarget", { sessionId: "other-tab", targetInfo: { type: "page" } });
    const tree = await state.transport.command("Page.getFrameTree", {});
    expect(tree.frameTree.childFrames[0].frame.id).toBe("child");
    expect(state.calls.mock.calls.some(([source]) => source.sessionId === "other-tab")).toBe(false);
  });

  it("routes colliding execution contexts and object IDs to the correct child", async () => {
    const state = harness();
    state.transport.event({ tabId: 10 }, "Target.attachedToTarget", { sessionId: "child-session", targetInfo: { type: "iframe" } });
    await state.transport.command("Page.getFrameTree", {});
    const root = await state.transport.command("Page.createIsolatedWorld", { frameId: "root" });
    const child = await state.transport.command("Page.createIsolatedWorld", { frameId: "child" });
    expect(root.executionContextId).not.toBe(child.executionContextId);
    expect(await state.transport.command("Runtime.evaluate", { contextId: child.executionContextId, returnByValue: true })).toEqual({ result: { value: "child-session" } });
    const object = await state.transport.command("Runtime.evaluate", { contextId: child.executionContextId });
    await state.transport.command("DOM.setFileInputFiles", { objectId: object.result.objectId, files: ["D:/work/fixture.txt"] });
    expect(state.calls).toHaveBeenLastCalledWith({ tabId: 10, sessionId: "child-session" }, "DOM.setFileInputFiles", { objectId: "same-object", files: ["D:/work/fixture.txt"] });
    const repeated = await state.transport.command("Page.createIsolatedWorld", { frameId: "child" });
    expect(repeated.executionContextId).toBe(child.executionContextId);
  });

  it("revokes old contexts on navigation without replay or cross-profile commands", async () => {
    const first = harness(10);
    const second = harness(20);
    await first.transport.command("Page.getFrameTree", {});
    const context = await first.transport.command("Page.createIsolatedWorld", { frameId: "root" });
    first.transport.event({ tabId: 10 }, "Runtime.executionContextsCleared", {});
    await expect(first.transport.command("Runtime.evaluate", { contextId: context.executionContextId })).rejects.toThrow("expired");
    expect(second.calls).not.toHaveBeenCalled();
    first.transport.dispose();
    await expect(first.transport.command("Page.getFrameTree", {})).rejects.toThrow("detached");
  });

  it("leaves out a child frame that does not answer instead of waiting on it", async () => {
    vi.useFakeTimers();
    try {
      const state = harness();
      const answer = state.calls.getMockImplementation();
      state.calls.mockImplementation((source, method, params) =>
        source.sessionId === "stuck-session" && method === "Page.getFrameTree" ? new Promise(() => {}) : answer(source, method, params));
      state.transport.event({ tabId: 10 }, "Target.attachedToTarget", { sessionId: "child-session", targetInfo: { type: "iframe" } });
      state.transport.event({ tabId: 10 }, "Target.attachedToTarget", { sessionId: "stuck-session", targetInfo: { type: "iframe" } });
      const pending = state.transport.command("Page.getFrameTree", {});
      await vi.advanceTimersByTimeAsync(1000);
      const tree = await pending;
      expect(tree.frameTree.childFrames.map((frame) => frame.frame.id)).toEqual(["child"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
