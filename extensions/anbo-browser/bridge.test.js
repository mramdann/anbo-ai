import { describe, expect, it, vi } from "vitest";
import { createDispatcher, profileLabel, tabInfo, validateCommand } from "./bridge.js";

function command(overrides = {}) {
  return { type: "command", id: 1, tabId: 10, selectionId: "lease", method: "Runtime.evaluate", params: {}, expiresAt: Date.now() + 10_000, ...overrides };
}

function harness(tabs = [10]) {
  const attached = new Map(tabs.map((id) => [id, { selectionId: "lease" }]));
  const api = {
    debugger: { sendCommand: vi.fn(async () => ({ value: "ok" })), detach: vi.fn(async () => {}) },
    tabs: { update: vi.fn(async () => ({ windowId: 20 })) },
    windows: { update: vi.fn(async () => ({})) },
  };
  const replies = [];
  let active = true;
  return { api, attached, replies, revoke: () => { active = false; }, dispatch: createDispatcher(api, attached, (reply) => replies.push(reply), () => active) };
}

describe("profile label", () => {
  it("may be left empty so Anbo names the profile", () => {
    expect(profileLabel("")).toBe("");
    expect(profileLabel(undefined)).toBe("");
    expect(profileLabel("  Work  ")).toBe("Work");
  });
  it("refuses control characters and long labels", () => {
    expect(() => profileLabel("Work\u0007")).toThrow("up to 64 characters");
    expect(() => profileLabel("x".repeat(65))).toThrow("up to 64 characters");
    expect(profileLabel("x".repeat(64))).toHaveLength(64);
  });
});

describe("external browser bridge", () => {
  it("rejects a stale selection lease before sending any input", async () => {
    const state = harness();
    await state.dispatch(command({ method: "Input.insertText", selectionId: "old-lease", params: { text: "never sent" } }));
    expect(state.api.debugger.sendCommand).not.toHaveBeenCalled();
    expect(state.replies[0].error).toContain("lease");
  });
  it("rejects unshared, expired, malformed and cross-target commands", () => {
    const attached = new Map([[10, { selectionId: "lease" }]]);
    for (const invalid of [
      { tabId: 11 }, { expiresAt: Date.now() - 1 }, { expiresAt: Date.now() + 100_000 },
      { id: 0 }, { params: [] }, { method: "Browser.close" }, { method: "Target.attachToTarget" },
    ]) expect(() => validateCommand(command(invalid), attached)).toThrow();
  });

  it("refuses privileged pages and bounds metadata", () => {
    expect(tabInfo({ id: 10, url: "https://example.com", title: "a".repeat(1024) }).title).toHaveLength(256);
    for (const url of ["chrome://settings", "edge://settings", "file:///private.txt", "javascript:alert(1)"]) {
      expect(() => tabInfo({ id: 10, url })).toThrow();
    }
  });

  it("routes requests only to the selected tab without activating it", async () => {
    const state = harness();
    await state.dispatch(command());
    expect(state.api.debugger.sendCommand).toHaveBeenCalledWith({ tabId: 10 }, "Runtime.evaluate", {});
    expect(state.api.tabs.update).not.toHaveBeenCalled();
    expect(state.api.windows.update).not.toHaveBeenCalled();
    expect(state.replies).toEqual([{ type: "reply", id: 1, result: { value: "ok" } }]);
  });

  it("does not cross profile boundaries when browser tab IDs collide", async () => {
    const first = harness();
    const second = harness();
    await first.dispatch(command());
    expect(first.api.debugger.sendCommand).toHaveBeenCalledTimes(1);
    expect(second.api.debugger.sendCommand).not.toHaveBeenCalled();
  });

  it("serializes one tab while allowing a different tab to progress", async () => {
    const state = harness([10, 11]);
    let release;
    state.api.debugger.sendCommand.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const first = state.dispatch(command());
    const second = state.dispatch(command({ id: 2 }));
    const third = state.dispatch(command({ id: 3, tabId: 11 }));
    await third;
    expect(state.api.debugger.sendCommand).toHaveBeenCalledTimes(2);
    expect(state.replies[0].id).toBe(3);
    release({});
    await Promise.all([first, second]);
    expect(state.replies.map((reply) => reply.id)).toEqual([3, 1, 2]);
  });

  it("does not dispatch queued input after revocation", async () => {
    const state = harness();
    let release;
    state.api.debugger.sendCommand.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const first = state.dispatch(command());
    const second = state.dispatch(command({ id: 2, method: "Input.insertText", params: { text: "secret" } }));
    await Promise.resolve();
    await Promise.resolve();
    state.revoke();
    release({});
    await Promise.all([first, second]);
    expect(state.api.debugger.sendCommand).toHaveBeenCalledTimes(1);
    expect(state.replies.find((reply) => reply.id === 2).error).toContain("revoked");
  });

  it("does not replay duplicate requests or failed browser calls", async () => {
    const state = harness();
    state.api.debugger.sendCommand.mockRejectedValueOnce(new Error("detached"));
    await state.dispatch(command());
    await state.dispatch(command());
    expect(state.api.debugger.sendCommand).toHaveBeenCalledTimes(1);
    expect(state.replies.every((reply) => typeof reply.error === "string")).toBe(true);
  });

  it("rechecks tab consent after waiting for an earlier action", async () => {
    const state = harness();
    const waiting = state.dispatch(command());
    state.attached.delete(10);
    await waiting;
    expect(state.api.debugger.sendCommand).not.toHaveBeenCalled();
  });

  it("only focuses the real browser for an explicit focus request", async () => {
    const state = harness();
    await state.dispatch(command({ method: "anbo.focusTab" }));
    expect(state.api.tabs.update).toHaveBeenCalledWith(10, { active: true });
    expect(state.api.windows.update).toHaveBeenCalledWith(20, { focused: true });
  });

  it("allocates no polling timer on idle connections", () => {
    const interval = vi.spyOn(globalThis, "setInterval");
    const timeout = vi.spyOn(globalThis, "setTimeout");
    try {
      for (let index = 0; index < 10; index += 1) harness();
      expect(interval).not.toHaveBeenCalled();
      expect(timeout).not.toHaveBeenCalled();
    } finally { interval.mockRestore(); timeout.mockRestore(); }
  });

  it("expires a stuck screenshot without replaying it or queued input, leaving other tabs live", async () => {
    vi.useFakeTimers();
    try {
      const state = harness([10, 11]);
      let complete;
      state.api.debugger.sendCommand.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
      const capture = state.dispatch(command({ method: "Page.captureScreenshot" }));
      const input = state.dispatch(command({ id: 2, method: "Input.insertText", params: { text: "never sent" } }));
      await state.dispatch(command({ id: 3, tabId: 11 }));
      await vi.advanceTimersByTimeAsync(10_000);
      await Promise.all([capture, input]);
      expect(state.replies.find((reply) => reply.id === 1).error).toContain("timed out");
      expect(state.replies.find((reply) => reply.id === 2).error).toBeTruthy();
      expect(state.attached.has(10)).toBe(false);
      expect(state.attached.has(11)).toBe(true);
      expect(state.api.debugger.detach).toHaveBeenCalledExactlyOnceWith({ tabId: 10 });
      expect(state.api.debugger.sendCommand).toHaveBeenCalledTimes(2);
      const replacement = { selectionId: "new-lease" };
      state.attached.set(10, replacement);
      complete({ data: "late image" });
      await vi.advanceTimersByTimeAsync(0);
      expect(state.replies).toHaveLength(3);
      expect(state.attached.get(10)).toBe(replacement);
      await state.dispatch(command({ id: 4, selectionId: "new-lease" }));
      expect(state.replies.at(-1).result).toEqual({ value: "ok" });
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("does not revoke a replacement lease when an old action expires", async () => {
    vi.useFakeTimers();
    try {
      const state = harness();
      state.api.debugger.sendCommand.mockImplementationOnce(() => new Promise(() => {}));
      const action = state.dispatch(command());
      await vi.advanceTimersByTimeAsync(0);
      const replacement = { selectionId: "new-lease" };
      state.attached.set(10, replacement);
      await vi.advanceTimersByTimeAsync(10_000);
      await action;
      expect(state.attached.get(10)).toBe(replacement);
      expect(state.api.debugger.detach).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("keeps tab control after a viewport screenshot timeout and bounds unresolved captures", async () => {
    vi.useFakeTimers();
    try {
      const state = harness([10, 11]);
      const selection = state.attached.get(10);
      let complete;
      state.api.debugger.sendCommand.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
      const params = { format: "png", fromSurface: true, captureBeyondViewport: false };
      const capture = state.dispatch(command({ method: "Page.captureScreenshot", params }));
      const queued = state.dispatch(command({ id: 2, method: "Input.insertText", params: { text: "expired" } }));
      await vi.advanceTimersByTimeAsync(10_000);
      await Promise.all([capture, queued]);
      expect(state.replies[0].error).toContain("Tab control remains connected");
      expect(state.replies[1].error).toBeTruthy();
      expect(state.attached.get(10)).toBe(selection);
      expect(state.api.debugger.detach).not.toHaveBeenCalled();
      await state.dispatch(command({ id: 3, method: "Page.captureScreenshot", params }));
      expect(state.replies.at(-1).error).toContain("previous screenshot");
      await state.dispatch(command({ id: 4, method: "Input.insertText", params: { text: "new request" } }));
      await state.dispatch(command({ id: 5 }));
      await state.dispatch(command({ id: 6, tabId: 11, method: "Page.captureScreenshot", params }));
      expect(state.replies.slice(-3).every((reply) => reply.result)).toBe(true);
      expect(state.api.debugger.sendCommand.mock.calls.filter(([, method]) => method === "Input.insertText")).toEqual([[{ tabId: 10 }, "Input.insertText", { text: "new request" }]]);
      complete({ data: "discarded late image" });
      await vi.advanceTimersByTimeAsync(0);
      expect(state.replies).toHaveLength(6);
      await state.dispatch(command({ id: 7, method: "Page.captureScreenshot", params }));
      expect(state.replies.at(-1).result).toBeTruthy();
      expect(state.api.tabs.update).not.toHaveBeenCalled();
      expect(state.api.windows.update).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("does not exempt captures that can alter viewport emulation from timeout revocation", async () => {
    vi.useFakeTimers();
    try {
      for (const params of [
        { fromSurface: true, captureBeyondViewport: true },
        { fromSurface: true, captureBeyondViewport: false, clip: { x: 0, y: 0, width: 100, height: 100, scale: 1 } },
      ]) {
        const state = harness();
        state.api.debugger.sendCommand.mockImplementationOnce(() => new Promise(() => {}));
        const capture = state.dispatch(command({ method: "Page.captureScreenshot", params }));
        await vi.advanceTimersByTimeAsync(10_000);
        await capture;
        expect(state.attached.has(10)).toBe(false);
        expect(state.api.debugger.detach).toHaveBeenCalledExactlyOnceWith({ tabId: 10 });
        expect(vi.getTimerCount()).toBe(0);
      }
    } finally { vi.useRealTimers(); }
  });

  it("limits stalled viewport captures across tabs without losing their leases", async () => {
    vi.useFakeTimers();
    try {
      const tabs = Array.from({ length: 33 }, (_, index) => index + 1);
      const state = harness(tabs);
      state.api.debugger.sendCommand.mockImplementation(() => new Promise(() => {}));
      const params = { fromSurface: true, captureBeyondViewport: false };
      for (const tabId of tabs) {
        const capture = state.dispatch(command({ id: tabId, tabId, method: "Page.captureScreenshot", params }));
        await vi.advanceTimersByTimeAsync(10_000);
        await capture;
      }
      expect(state.api.debugger.sendCommand).toHaveBeenCalledTimes(32);
      expect(state.replies.at(-1).error).toContain("previous screenshot");
      expect(state.attached.size).toBe(33);
      expect(state.api.debugger.detach).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("does not focus a window after the tab activation request expires", async () => {
    vi.useFakeTimers();
    try {
      const state = harness();
      let complete;
      state.api.tabs.update.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
      const action = state.dispatch(command({ method: "anbo.focusTab" }));
      await vi.advanceTimersByTimeAsync(10_000);
      await action;
      complete({ windowId: 20 });
      await vi.advanceTimersByTimeAsync(0);
      expect(state.api.windows.update).not.toHaveBeenCalled();
      expect(state.replies).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("clears command deadlines after success and failure", async () => {
    vi.useFakeTimers();
    try {
      const state = harness();
      await state.dispatch(command());
      state.api.debugger.sendCommand.mockRejectedValueOnce(new Error("CDP failed"));
      await state.dispatch(command({ id: 2 }));
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(state.attached.has(10)).toBe(true);
      expect(state.api.debugger.detach).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
});
