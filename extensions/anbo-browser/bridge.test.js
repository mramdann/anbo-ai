import { describe, expect, it, vi } from "vitest";
import { createDispatcher, NETWORK_EVENTS, networkSummary, profileLabel, RELOAD_RECONNECT_MS, reconnectsAfterReload, tabInfo, validateCommand } from "./bridge.js";

describe("networkSummary", () => {
  it("passes on what a request did, never its headers, body or credentials", () => {
    const started = networkSummary("s1", "Network.requestWillBeSent", { requestId: "7", type: "Fetch", request: { url: "https://user:secret@x.test/api?q=1", method: "POST", headers: { Cookie: "a=b" }, postData: "secret" }, initiator: { stack: {} } });
    expect(started).toEqual({ requestId: "s1:7", request: { url: "https://x.test/api?q=1", method: "POST" }, type: "Fetch" });
    const redirected = networkSummary(undefined, "Network.requestWillBeSent", { requestId: "8", request: { url: "https://x.test/new", method: "GET" }, redirectResponse: { status: 301, headers: { Location: "/new" } } });
    expect(redirected).toEqual({ requestId: ":8", request: { url: "https://x.test/new", method: "GET" }, redirectResponse: { status: 301 } });
    expect(networkSummary("", "Network.responseReceived", { requestId: "7", response: { status: 404, headers: { "Set-Cookie": "x" }, securityDetails: {} } })).toEqual({ requestId: ":7", response: { status: 404 } });
    expect(networkSummary("", "Network.loadingFinished", { requestId: "7", encodedDataLength: 512, timestamp: 1.5 })).toEqual({ requestId: ":7", encodedDataLength: 512, timestamp: 1.5 });
    expect(networkSummary("", "Network.loadingFailed", { requestId: "7", errorText: "net::ERR_ABORTED", canceled: true, timestamp: 2 })).toEqual({ requestId: ":7", errorText: "net::ERR_ABORTED", canceled: true, timestamp: 2 });
    expect(networkSummary("", "Network.responseReceived", { requestId: "7", response: { status: 200 }, timestamp: "soon" })).toEqual({ requestId: ":7", response: { status: 200 } });
  });

  it("cuts a long URL with a mark, and passes on only the four events Anbo reads", () => {
    const url = `data:text/plain,${"a".repeat(2000)}`;
    expect(networkSummary("", "Network.requestWillBeSent", { requestId: "1", request: { url, method: "GET" } }).request.url).toBe(`${url.slice(0, 512)}...`);
    expect([...NETWORK_EVENTS]).toEqual(["Network.requestWillBeSent", "Network.responseReceived", "Network.loadingFinished", "Network.loadingFailed"]);
  });

  it("hides what is shaped like a credential in a URL and keeps the rest", () => {
    const listed = (url) => networkSummary("", "Network.requestWillBeSent", { requestId: "1", request: { url, method: "GET" } }).request.url;
    // By the parameter's name, in any spelling.
    expect(listed("https://api.test/v1/items?access_token=tok123&page=2&q=red+shoes&keyword=key&t=1697000000000")).toBe("https://api.test/v1/items?access_token=<REDACTED>&page=2&q=red+shoes&keyword=key&t=1697000000000");
    expect(listed("https://x.test/cb?sessionId=abc&PHPSESSID=q1w2&apiKey=k&X-Api-Key=k2&client_secret=s&debug")).toBe("https://x.test/cb?sessionId=<REDACTED>&PHPSESSID=<REDACTED>&apiKey=<REDACTED>&X-Api-Key=<REDACTED>&client_secret=<REDACTED>&debug");
    expect(listed("https://s3.test/f.png?X-Amz-Credential=AKIDEXAMPLE%2F20261011&X-Amz-Date=20261011T000000Z&X-Amz-Expires=300&X-Amz-Signature=fe5f80f77d5fa3beca038a248ff027d0445342fe2855ddc963176630326f1024")).toBe("https://s3.test/f.png?X-Amz-Credential=<REDACTED>&X-Amz-Date=20261011T000000Z&X-Amz-Expires=300&X-Amz-Signature=<REDACTED>");
    // By the value's shape: an OAuth code or state, a JWT or a known key, also in the path.
    expect(listed("https://x.test/cb?code=4%2F0AY0e-g7abcDEF123ghiJKL456&state=Zx9Kq2Lm8Np4Rt6Vw1Yb3Cd5&scope=email")).toBe("https://x.test/cb?code=<REDACTED>&state=<REDACTED>&scope=email");
    expect(listed("https://x.test/magic/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U/open")).toBe("https://x.test/magic/<REDACTED>/open");
    expect(listed("wss://rt.test/socket?apikey=pk.abc&vsn=1.0.0")).toBe("wss://rt.test/socket?apikey=<REDACTED>&vsn=1.0.0");
    // A search with numbers, a country code and a short id stay readable.
    expect(listed("https://shop.test/search?q=iphone+15+pro+max+256gb&code=US&id=42&lang=en")).toBe("https://shop.test/search?q=iphone+15+pro+max+256gb&code=US&id=42&lang=en");
    expect(listed("https://x.test/plain")).toBe("https://x.test/plain");
  });
});

function command(overrides = {}) {
  return { type: "command", id: 1, tabId: 10, selectionId: "lease", method: "Runtime.evaluate", params: {}, expiresAt: Date.now() + 10_000, ...overrides };
}

function harness(tabs = [10]) {
  const attached = new Map(tabs.map((id) => [id, { selectionId: "lease" }]));
  const api = {
    debugger: { sendCommand: vi.fn(async () => ({ value: "ok" })), detach: vi.fn(async () => {}) },
    tabs: { update: vi.fn(async () => ({ windowId: 20 })), get: vi.fn(async (id) => ({ id, windowId: 20, active: false })) },
    windows: { update: vi.fn(async () => ({})), get: vi.fn(async (id) => ({ id, state: "normal" })) },
  };
  const replies = [];
  let active = true;
  return { api, attached, replies, revoke: () => { active = false; }, dispatch: createDispatcher(api, attached, (reply) => replies.push(reply), () => active) };
}

describe("reload Anbo asked for", () => {
  it("connects again on its own only while it is recent", () => {
    const at = 1_000_000;
    expect(reconnectsAfterReload(at, at + 500)).toBe(true);
    expect(reconnectsAfterReload(at, at + RELOAD_RECONNECT_MS - 1)).toBe(true);
    expect(reconnectsAfterReload(at, at + RELOAD_RECONNECT_MS)).toBe(false);
    expect(reconnectsAfterReload(at, at - 1)).toBe(false);
    expect(reconnectsAfterReload(undefined, at)).toBe(false);
    expect(reconnectsAfterReload("soon", at)).toBe(false);
  });
  it("is a profile command, never one for a tab", () => {
    expect(() => validateCommand(command({ tabId: 0, selectionId: undefined, method: "anbo.reloadExtension" }), new Map())).not.toThrow();
    expect(() => validateCommand(command({ tabId: 10, method: "anbo.reloadExtension" }), new Map([[10, { selectionId: "lease" }]]))).toThrow("unselected");
  });
});

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

  it("never lets an agent read or change the signed-in profile's cookies", async () => {
    const attached = new Map([[10, { selectionId: "lease" }]]);
    for (const method of [
      "Network.getCookies", "Network.getAllCookies", "Network.setCookie", "Network.setCookies",
      "Network.deleteCookies", "Network.clearBrowserCookies", "Page.getCookies", "Page.deleteCookie",
    ]) expect(() => validateCommand(command({ method }), attached)).toThrow("Cookie access");
    expect(validateCommand(command({ method: "Network.enable" }), attached).method).toBe("Network.enable");
    const state = harness();
    await state.dispatch(command({ method: "Network.getAllCookies" }));
    expect(state.api.debugger.sendCommand).not.toHaveBeenCalled();
    expect(state.replies[0].error).toContain("Cookie access");
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

  it("says whether the browser shows the tab, and changes nothing", async () => {
    const state = harness();
    await state.dispatch(command({ method: "anbo.tabState" }));
    expect(state.replies.at(-1)).toMatchObject({ result: { active: false, split: false, minimized: false } });
    state.api.tabs.get.mockResolvedValueOnce({ id: 10, windowId: 20, active: false, splitViewId: 3 });
    state.api.windows.get.mockResolvedValueOnce({ id: 20, state: "minimized" });
    await state.dispatch(command({ id: 2, method: "anbo.tabState" }));
    expect(state.replies.at(-1)).toMatchObject({ result: { active: false, split: true, minimized: true } });
    expect(state.api.tabs.update).not.toHaveBeenCalled();
    expect(state.api.windows.update).not.toHaveBeenCalled();
    expect(state.api.debugger.sendCommand).not.toHaveBeenCalled();
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
