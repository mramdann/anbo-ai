import { describe, expect, it, vi } from "vitest";
import { createDispatcher, STUCK_MS } from "./bridge.js";
import { createTabManager, EXTENSION_VERSION } from "./tabs.js";
import manifest from "./manifest.json";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function harness(reload, { renderers } = {}) {
  const tabs = new Map([
    [10, { id: 10, title: "Work", url: "https://example.com/", windowId: 20 }],
    [11, { id: 11, title: "Other", url: "https://other.example/", windowId: 20 }],
  ]);
  const selected = new Map();
  const publications = [];
  const replies = [];
  let active = true;
  let nextId = 0;
  const event = () => {
    const listeners = new Set();
    return { addListener: (listener) => listeners.add(listener), removeListener: (listener) => listeners.delete(listener), emit: (...args) => { for (const listener of [...listeners]) listener(...args); }, listeners };
  };
  const api = {
    tabs: {
      onUpdated: event(),
      onRemoved: event(),
      get: vi.fn(async (tabId) => {
        if (!tabs.has(tabId)) throw new Error("Tab closed");
        return { ...tabs.get(tabId) };
      }),
      query: vi.fn(async () => [...tabs.values()]),
      create: vi.fn(async ({ url, windowId }) => {
        const tab = { id: 12, url, windowId, title: "New" };
        tabs.set(12, tab);
        return tab;
      }),
      update: vi.fn(async () => ({ windowId: 20 })),
      remove: vi.fn(),
    },
    debugger: {
      attach: vi.fn(async () => {}),
      detach: vi.fn(async () => {}),
      sendCommand: vi.fn(async () => ({})),
    },
    windows: {
      getAll: vi.fn(async () => [{ id: 20, incognito: false, focused: true }]),
      get: vi.fn(async (windowId) => ({ id: windowId, type: windowId === 21 ? "popup" : "normal", incognito: false })),
      update: vi.fn(async () => ({})),
    },
  };
  api.runtime = { getManifest: () => ({ version: "0.5.1" }) };
  // The browser's id for each tab's renderer, when the profile grants webNavigation.
  // getFrame leaves processId out, as the browser does.
  if (renderers) api.webNavigation = {
    getFrame: vi.fn(async ({ frameId }) => ({ frameType: frameId === 0 ? "outermost_frame" : "sub_frame", parentFrameId: frameId === 0 ? -1 : 0 })),
    getAllFrames: vi.fn(async ({ tabId }) => (renderers.has(tabId) ? [{ frameId: 3, parentFrameId: 0, processId: 99 }, { frameId: 0, parentFrameId: -1, processId: renderers.get(tabId) }] : null)),
  };
  const kept = [];
  const closed = [];
  const manager = createTabManager(api, selected, () => publications.push([...selected.values()].map((tab) => ({ ...tab }))), undefined, reload, (ids) => kept.push(ids), (tabId, selectionId) => closed.push([tabId, selectionId]));
  const dispatch = createDispatcher(api, selected, (reply) => replies.push(reply), () => active, manager);
  const run = async (method, tabId = 0, params = {}) => {
    const id = ++nextId;
    await dispatch({ type: "command", id, tabId, selectionId: selected.get(tabId)?.selectionId, method, params, expiresAt: Date.now() + 10_000 });
    return replies.find((reply) => reply.id === id);
  };
  return { api, tabs, selected, publications, kept, closed, manager, run, revoke: () => { active = false; } };
}

describe("tabs selected directly from Anbo", () => {
  it.each(["complete", "loading"])("publishes the final %s snapshot after debugger setup without extra polling", async (status) => {
    const state = harness();
    state.tabs.get(10).status = status === "complete" ? "loading" : "complete";
    state.api.debugger.sendCommand.mockImplementation(async (_source, method) => {
      if (method === "Target.setAutoAttach") {
        const updated = { ...state.tabs.get(10), status, title: "Latest title" };
        state.tabs.set(10, updated);
        state.manager.updated(10, { status, title: updated.title }, updated);
      }
      return {};
    });
    const response = await state.run("anbo.selectTab", 10, { expectedUrl: "https://example.com/" });
    expect(response.error).toBeUndefined();
    expect(response.result).toMatchObject({ loading: status === "loading", title: "Latest title", generation: 1, createdByAnbo: false });
    expect(state.selected.get(10)).toEqual(response.result);
    expect(state.publications).toEqual([[response.result]]);
    expect(state.api.tabs.get).toHaveBeenCalledTimes(3);
    expect(state.api.tabs.query).not.toHaveBeenCalled();
  });

  it.each(["revoke", "removed"])("does not publish a late final snapshot after %s", async (reason) => {
    const state = harness();
    const pending = deferred();
    const started = deferred();
    const snapshot = { ...state.tabs.get(10) };
    state.api.tabs.get
      .mockResolvedValueOnce(snapshot)
      .mockResolvedValueOnce(snapshot)
      .mockImplementationOnce(() => { started.resolve(); return pending.promise; });
    const selection = state.run("anbo.selectTab", 10, { expectedUrl: snapshot.url });
    await started.promise;
    if (reason === "revoke") state.revoke();
    else state.manager.removed(10);
    pending.resolve(snapshot);
    expect((await selection).error).toBeTruthy();
    expect(state.selected.size).toBe(0);
    expect(state.publications).toEqual([]);
    expect(state.api.debugger.detach).toHaveBeenCalledWith({ tabId: 10 });
  });

  it("opens automation tabs in the background and closes only tabs it created", async () => {
    const state = harness();
    await state.run("anbo.openTab", 0, { url: "https://example.com/", activate: false });
    expect(state.api.tabs.create).toHaveBeenCalledWith({ windowId: 20, url: "https://example.com/", active: false });
    expect(state.api.windows.update).not.toHaveBeenCalled();
    expect((await state.run("anbo.closeTab", 12)).result).toEqual({ closed: true });
    expect(state.api.tabs.remove).toHaveBeenCalledExactlyOnceWith(12);
    await state.run("anbo.selectTab", 10, { expectedUrl: "https://example.com/" });
    expect((await state.run("anbo.closeTab", 10)).result).toEqual({ closed: false });
    expect(state.api.tabs.remove).toHaveBeenCalledTimes(1);
  });

  it("closes the browser's tab of any Anbo tab closed on purpose, and never one let go first", async () => {
    const state = harness();
    await state.run("anbo.selectTab", 10, { expectedUrl: "https://example.com/" });
    expect((await state.run("anbo.closeTab", 10, { close: true })).result).toEqual({ closed: true });
    expect(state.api.tabs.remove).toHaveBeenCalledExactlyOnceWith(10);
    // A tab Anbo opened stays when its Anbo tab only moved on.
    await state.run("anbo.openTab", 0, { url: "https://example.com/", activate: false });
    expect((await state.run("anbo.closeTab", 12, { close: false })).result).toEqual({ closed: false });
    expect(state.api.tabs.remove).toHaveBeenCalledTimes(1);
    // The menu's return lets go first; the close after it finds nothing to close.
    await state.run("anbo.selectTab", 11, { expectedUrl: "https://other.example/" });
    await state.run("anbo.releaseTab", 11);
    expect((await state.run("anbo.closeTab", 11, { close: true })).result).toEqual({ closed: false });
    expect(state.api.tabs.remove).toHaveBeenCalledTimes(1);
  });

  it("says a tab was closed in the browser on its own, not with its window and not when Anbo closed it", async () => {
    const state = harness();
    await state.run("anbo.selectTab", 10, { expectedUrl: "https://example.com/" });
    const lease = state.selected.get(10).selectionId;
    state.manager.removed(10, { isWindowClosing: false, windowId: 20 });
    expect(state.closed).toEqual([[10, lease]]);
    expect(state.selected.has(10)).toBe(false);
    // Closed with its whole window, as when the browser quits: Anbo's tab waits for the profile.
    await state.run("anbo.selectTab", 11, { expectedUrl: "https://other.example/" });
    state.manager.removed(11, { isWindowClosing: true, windowId: 20 });
    expect(state.closed).toHaveLength(1);
    // Anbo lets a tab go before it closes it, so its own close says nothing.
    await state.run("anbo.openTab", 0, { url: "https://example.com/", activate: false });
    await state.run("anbo.closeTab", 12, { close: true });
    state.manager.removed(12, { isWindowClosing: false, windowId: 20 });
    // Nor does a tab Anbo never held, or an older caller that gives no reason.
    state.manager.removed(99, { isWindowClosing: false, windowId: 20 });
    await state.run("anbo.selectTab", 10, { expectedUrl: "https://example.com/" });
    state.manager.removed(10);
    expect(state.closed).toHaveLength(1);
  });

  it("keeps selection identity stable across metadata changes but advances document epochs", async () => {
    const state = harness();
    await state.run("anbo.selectTab", 10, { expectedUrl: "https://example.com/" });
    const original = { ...state.selected.get(10) };
    state.manager.updated(10, { title: "Clock" }, { ...state.tabs.get(10), title: "Clock" });
    expect(state.selected.get(10).generation).toBe(original.generation);
    state.manager.updated(10, { status: "loading" }, { ...state.tabs.get(10), status: "loading" });
    expect(state.selected.get(10).generation).toBeGreaterThan(original.generation);
    expect(state.selected.get(10).selectionId).toBe(original.selectionId);
  });
  it("names a tab's renderer to the host before attaching, and lets it go with the tab", async () => {
    const state = harness(undefined, { renderers: new Map([[10, 7], [12, 9]]) });
    const order = [];
    state.api.debugger.attach.mockImplementation(async ({ tabId }) => { order.push(`attach ${tabId} with ${state.kept.at(-1)}`); });
    await state.run("anbo.selectTab", 10, { expectedUrl: "https://example.com/" });
    expect(state.kept).toEqual([[7]]);
    await state.run("anbo.openTab", 0, { url: "https://example.com/", activate: false });
    expect(state.kept).toEqual([[7], [7, 9]]);
    expect(order).toEqual(["attach 10 with 7", "attach 12 with 7,9"]);
    await state.run("anbo.releaseTab", 10);
    expect(state.kept.at(-1)).toEqual([9]);
    await state.run("anbo.closeTab", 12);
    expect(state.kept.at(-1)).toEqual([]);
  });

  it("forgets the renderer of a tab whose selection fails", async () => {
    const state = harness(undefined, { renderers: new Map([[10, 7]]) });
    state.api.debugger.attach.mockRejectedValueOnce(new Error("Another debugger is already attached"));
    expect((await state.run("anbo.selectTab", 10, { expectedUrl: "https://example.com/" })).error).toContain("Another debugger");
    expect(state.kept).toEqual([[7], []]);
  });

  it("follows a driven tab to the renderer of the site it moved to", async () => {
    const state = harness(undefined, { renderers: new Map([[10, 7]]) });
    await state.run("anbo.selectTab", 10, { expectedUrl: "https://example.com/" });
    state.manager.committed({ tabId: 10, frameId: 0, processId: 15 });
    state.manager.committed({ tabId: 10, frameId: 3, processId: 21 });
    state.manager.committed({ tabId: 11, frameId: 0, processId: 22 });
    state.manager.committed({ tabId: 10, frameId: 0, processId: 15 });
    expect(state.kept).toEqual([[7], [15]]);
  });

  it("drives tabs as before where the browser names no renderer", async () => {
    const state = harness();
    expect((await state.run("anbo.selectTab", 10, { expectedUrl: "https://example.com/" })).error).toBeUndefined();
    await state.run("anbo.releaseTab", 10);
    expect(state.kept).toEqual([]);
  });

  it("tells Anbo which extension version runs", async () => {
    const state = harness();
    expect((await state.run("anbo.version")).result).toEqual({ version: EXTENSION_VERSION });
    // The code says its own version, which a release keeps equal to the manifest.
    expect(EXTENSION_VERSION).toBe(manifest.version);
    expect(state.api.debugger.attach).not.toHaveBeenCalled();
    expect(state.api.tabs.query).not.toHaveBeenCalled();
  });

  it("answers a reload request before it reloads", async () => {
    const reload = vi.fn();
    const state = harness(reload);
    expect((await state.run("anbo.reloadExtension")).result).toEqual({ reloading: true });
    expect(reload).toHaveBeenCalledOnce();
    expect(state.api.debugger.attach).not.toHaveBeenCalled();
  });

  it("lists only normal web tab metadata on demand without attaching", async () => {
    const state = harness();
    state.tabs.set(13, { id: 13, url: "chrome://extensions" });
    state.tabs.set(14, { id: 14, url: "https://private.example/", incognito: true });
    const response = await state.run("anbo.listTabs");
    expect(response.result.map((tab) => tab.id)).toEqual([10, 11]);
    expect(state.api.debugger.attach).not.toHaveBeenCalled();
    expect(state.api.debugger.sendCommand).not.toHaveBeenCalled();
    expect(state.selected.size).toBe(0);
  });

  it("requires profile approval before listing, selecting or opening", async () => {
    const state = harness();
    state.revoke();
    for (const [method, tabId, params] of [
      ["anbo.listTabs", 0, {}],
      ["anbo.selectTab", 10, { expectedUrl: "https://example.com/" }],
      ["anbo.openTab", 0, { url: "https://example.com/" }],
    ]) expect((await state.run(method, tabId, params)).error).toBeTruthy();
    expect(state.api.tabs.query).not.toHaveBeenCalled();
    expect(state.api.tabs.create).not.toHaveBeenCalled();
    expect(state.api.debugger.attach).not.toHaveBeenCalled();
  });

  it("selects one tab without popup sharing and does not authorize other tabs", async () => {
    const state = harness();
    expect((await state.run("anbo.selectTab", 10, { expectedUrl: "https://example.com/" })).result.id).toBe(10);
    expect(state.api.debugger.attach).toHaveBeenCalledExactlyOnceWith({ tabId: 10 }, "1.3");
    expect(state.api.tabs.update).not.toHaveBeenCalled();
    expect(state.api.windows.update).not.toHaveBeenCalled();
    expect((await state.run("Runtime.evaluate", 10)).result).toEqual({});
    expect((await state.run("Runtime.evaluate", 11)).error).toBeTruthy();
    expect(state.publications).toHaveLength(1);
  });

  it("does not cross profiles when their tab IDs are the same", async () => {
    const first = harness();
    const second = harness();
    await first.run("anbo.selectTab", 10, { expectedUrl: "https://example.com/" });
    expect(second.selected.size).toBe(0);
    expect(second.api.debugger.attach).not.toHaveBeenCalled();
  });

  it("rejects a stale picker URL before attaching", async () => {
    const state = harness();
    state.tabs.get(10).url = "https://changed.example/";
    expect((await state.run("anbo.selectTab", 10, { expectedUrl: "https://example.com/" })).error).toContain("navigated");
    expect(state.api.debugger.attach).not.toHaveBeenCalled();
  });

  it("detaches if navigation races with attachment", async () => {
    const state = harness();
    state.api.debugger.attach.mockImplementationOnce(async () => { state.tabs.get(10).url = "https://changed.example/"; });
    expect((await state.run("anbo.selectTab", 10, { expectedUrl: "https://example.com/" })).error).toContain("navigated");
    expect(state.selected.size).toBe(0);
    expect(state.api.debugger.detach).toHaveBeenCalledWith({ tabId: 10 });
  });

  it("never takes over another debugger or silently falls back to another tab", async () => {
    const state = harness();
    state.api.debugger.attach.mockRejectedValueOnce(new Error("Another debugger is attached"));
    expect((await state.run("anbo.selectTab", 10, { expectedUrl: "https://example.com/" })).error).toContain("Another debugger");
    expect(state.api.debugger.attach).toHaveBeenCalledTimes(1);
    expect(state.api.debugger.detach).not.toHaveBeenCalled();
    expect(state.selected.size).toBe(0);
  });

  it("opens and selects only in a regular window of the connected profile", async () => {
    const state = harness();
    state.api.windows.getAll.mockResolvedValueOnce([{ id: 99, incognito: true, focused: true }, { id: 20, incognito: false }]);
    const response = await state.run("anbo.openTab", 0, { url: "https://example.com" });
    expect(response.result.id).toBe(12);
    expect(state.api.tabs.create).toHaveBeenCalledWith({ windowId: 20, url: "https://example.com/", active: true });
    expect(state.api.debugger.attach).toHaveBeenCalledWith({ tabId: 12 }, "1.3");
    expect(state.api.windows.update).toHaveBeenCalledWith(20, { focused: true });
    expect(state.api.tabs.remove).not.toHaveBeenCalled();
  });

  it("refuses opening in an incognito-only profile window set", async () => {
    const state = harness();
    state.api.windows.getAll.mockResolvedValueOnce([{ id: 99, incognito: true }]);
    expect((await state.run("anbo.openTab", 0, { url: "https://example.com/" })).error).toContain("regular window");
    expect(state.api.tabs.create).not.toHaveBeenCalled();
  });

  it("waits for a new tab to commit using events, then removes its temporary listeners", async () => {
    const state = harness();
    state.api.tabs.create.mockImplementationOnce(async ({ url, windowId }) => {
      const tab = { id: 12, url: "", pendingUrl: url, windowId };
      state.tabs.set(12, tab);
      return tab;
    });
    const opening = state.run("anbo.openTab", 0, { url: "https://example.com/" });
    await vi.waitFor(() => expect(state.api.tabs.onUpdated.listeners.size).toBe(1));
    expect(state.api.debugger.attach).not.toHaveBeenCalled();
    const loaded = { id: 12, url: "https://example.com/", windowId: 20 };
    state.tabs.set(12, loaded);
    state.api.tabs.onUpdated.emit(12, { url: loaded.url }, loaded);
    expect((await opening).result.id).toBe(12);
    expect(state.api.tabs.onUpdated.listeners.size).toBe(0);
    expect(state.api.tabs.onRemoved.listeners.size).toBe(0);
    expect(state.api.debugger.attach).toHaveBeenCalledTimes(1);
  });

  it("follows a server redirect of the tab it opened to another web page", async () => {
    const state = harness();
    state.api.tabs.create.mockImplementationOnce(async ({ url, windowId }) => {
      const tab = { id: 12, url: "", pendingUrl: url, windowId };
      state.tabs.set(12, tab);
      return tab;
    });
    const opening = state.run("anbo.openTab", 0, { url: "https://example.com/" });
    await vi.waitFor(() => expect(state.api.tabs.onUpdated.listeners.size).toBe(1));
    const landed = { id: 12, url: "https://www.example.com/", title: "Example", windowId: 20 };
    state.tabs.set(12, landed);
    state.api.tabs.onUpdated.emit(12, { url: landed.url }, landed);
    const response = await opening;
    expect(response.result.url).toBe("https://www.example.com/");
    expect(response.result.createdByAnbo).toBe(true);
    expect(state.api.debugger.attach).toHaveBeenCalledTimes(1);
  });

  it("refuses a new tab that lands on a page that is not HTTP(S)", async () => {
    const state = harness();
    state.api.tabs.create.mockImplementationOnce(async ({ url, windowId }) => {
      const tab = { id: 12, url: "", pendingUrl: url, windowId };
      state.tabs.set(12, tab);
      return tab;
    });
    const opening = state.run("anbo.openTab", 0, { url: "https://example.com/" });
    await vi.waitFor(() => expect(state.api.tabs.onUpdated.listeners.size).toBe(1));
    const landed = { id: 12, url: "file:///C:/Users/Test/notes.html", windowId: 20 };
    state.tabs.set(12, landed);
    state.api.tabs.onUpdated.emit(12, { url: landed.url }, landed);
    expect((await opening).error).toContain("HTTP");
    expect(state.api.debugger.attach).not.toHaveBeenCalled();
    expect(state.api.tabs.onUpdated.listeners.size).toBe(0);
  });

  it("cancels a loading tab on disconnect without closing it or attaching later", async () => {
    const state = harness();
    state.api.tabs.create.mockImplementationOnce(async ({ url }) => {
      const tab = { id: 12, url: "about:blank", pendingUrl: url };
      state.tabs.set(12, tab);
      return tab;
    });
    const opening = state.run("anbo.openTab", 0, { url: "https://example.com/" });
    await vi.waitFor(() => expect(state.api.tabs.onUpdated.listeners.size).toBe(1));
    state.revoke();
    await state.manager.dispose();
    expect((await opening).error).toContain("revoked");
    expect(state.api.tabs.onUpdated.listeners.size).toBe(0);
    expect(state.api.debugger.attach).not.toHaveBeenCalled();
    expect(state.api.tabs.remove).not.toHaveBeenCalled();
  });

  it("closes a new tab again when its open runs out of time", async () => {
    vi.useFakeTimers();
    try {
      const state = harness();
      state.api.tabs.create.mockImplementationOnce(async ({ url, windowId }) => {
        const tab = { id: 12, url: "", pendingUrl: url, windowId };
        state.tabs.set(12, tab);
        return tab;
      });
      const opening = state.run("anbo.openTab", 0, { url: "https://example.com/", activate: false });
      await vi.advanceTimersByTimeAsync(10_000);
      expect((await opening).error).toContain("closed again");
      expect(state.api.tabs.remove).toHaveBeenCalledExactlyOnceWith(12);
      expect(state.api.debugger.attach).not.toHaveBeenCalled();
      expect(state.selected.size).toBe(0);
      expect(state.api.tabs.onUpdated.listeners.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("closes a new tab again when its selection outlasts the open", async () => {
    vi.useFakeTimers();
    try {
      const state = harness();
      const attachment = deferred();
      state.api.debugger.attach.mockReturnValueOnce(attachment.promise);
      const opening = state.run("anbo.openTab", 0, { url: "https://example.com/", activate: false });
      await vi.advanceTimersByTimeAsync(10_000);
      // Answered at the deadline, while the browser still attaches.
      expect((await opening).error).toContain("closed again");
      attachment.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(state.api.debugger.detach).toHaveBeenCalledWith({ tabId: 12 });
      expect(state.api.tabs.remove).toHaveBeenCalledExactlyOnceWith(12);
      expect(state.selected.size).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("does not close or retry a newly opened tab when its attachment fails", async () => {
    const state = harness();
    state.api.debugger.attach.mockRejectedValueOnce(new Error("Debugger unavailable"));
    expect((await state.run("anbo.openTab", 0, { url: "https://example.com/" })).error).toContain("Debugger unavailable");
    expect(state.api.tabs.create).toHaveBeenCalledTimes(1);
    expect(state.api.tabs.remove).not.toHaveBeenCalled();
  });

  it("cleans up attachment that completes after disconnect", async () => {
    const state = harness();
    const attachment = deferred();
    state.api.debugger.attach.mockReturnValueOnce(attachment.promise);
    const selection = state.run("anbo.selectTab", 10, { expectedUrl: "https://example.com/" });
    await vi.waitFor(() => expect(state.api.debugger.attach).toHaveBeenCalled());
    state.revoke();
    const disposal = state.manager.dispose();
    attachment.resolve();
    await disposal;
    expect((await selection).error).toContain("revoked");
    expect(state.api.debugger.detach).toHaveBeenCalledWith({ tabId: 10 });
    expect(state.selected.size).toBe(0);
    expect(state.publications).toHaveLength(0);
  });

  it("releasing a tab cancels an in-flight selection without closing the tab", async () => {
    const state = harness();
    const attachment = deferred();
    state.api.debugger.attach.mockReturnValueOnce(attachment.promise);
    const selection = state.run("anbo.selectTab", 10, { expectedUrl: "https://example.com/" });
    await vi.waitFor(() => expect(state.api.debugger.attach).toHaveBeenCalled());
    const release = state.run("anbo.releaseTab", 10);
    attachment.resolve();
    expect((await selection).error).toContain("revoked");
    expect((await release).result).toEqual({ closed: false });
    expect(state.selected.size).toBe(0);
    expect(state.api.debugger.detach).toHaveBeenCalledWith({ tabId: 10 });
    expect(state.api.tabs.remove).not.toHaveBeenCalled();
  });

  it("release immediately revokes queued input even behind a running command", async () => {
    const state = harness();
    await state.run("anbo.selectTab", 10, { expectedUrl: "https://example.com/" });
    const action = deferred();
    state.api.debugger.sendCommand.mockClear();
    state.api.debugger.sendCommand.mockReturnValueOnce(action.promise);
    const first = state.run("Runtime.evaluate", 10);
    await vi.waitFor(() => expect(state.api.debugger.sendCommand).toHaveBeenCalled());
    const queued = state.run("Input.insertText", 10, { text: "never sent" });
    const release = state.run("anbo.releaseTab", 10);
    expect(state.selected.size).toBe(0);
    action.resolve({});
    await Promise.all([first, release]);
    expect((await queued).error).toBeTruthy();
    expect(state.api.debugger.sendCommand.mock.calls.filter(([, method]) => method === "Input.insertText")).toHaveLength(0);
  });

  it("ignores unselected tab events and detaches selected privileged navigation", async () => {
    const state = harness();
    await state.run("anbo.selectTab", 10, { expectedUrl: "https://example.com/" });
    state.manager.updated(11, { title: "Changed" }, { ...state.tabs.get(11), title: "Changed" });
    expect(state.publications).toHaveLength(1);
    state.manager.updated(10, { url: "chrome://settings" }, { id: 10, url: "chrome://settings" });
    expect(state.selected.size).toBe(0);
    expect(state.api.debugger.detach).toHaveBeenCalledWith({ tabId: 10 });
    expect(state.api.tabs.query).not.toHaveBeenCalled();
  });

  it("clears authority when the user closes a tab or stops browser debugging", async () => {
    for (const event of ["removed", "detached"]) {
      const state = harness();
      await state.run("anbo.selectTab", 10, { expectedUrl: "https://example.com/" });
      state.api.debugger.sendCommand.mockClear();
      state.manager[event](10);
      expect((await state.run("Runtime.evaluate", 10)).error).toBeTruthy();
      expect(state.api.debugger.sendCommand).not.toHaveBeenCalled();
    }
  });

  it("allocates no polling timers or tab queries for idle connections", () => {
    const interval = vi.spyOn(globalThis, "setInterval");
    const timeout = vi.spyOn(globalThis, "setTimeout");
    try {
      const profiles = Array.from({ length: 10 }, () => harness());
      expect(interval).not.toHaveBeenCalled();
      expect(timeout).not.toHaveBeenCalled();
      for (const state of profiles) expect(state.api.tabs.query).not.toHaveBeenCalled();
    } finally { interval.mockRestore(); timeout.mockRestore(); }
  });

  it("keeps a tab whose capture finishes late, and sends nothing queued behind it", async () => {
    vi.useFakeTimers();
    try {
      const state = harness();
      await state.run("anbo.selectTab", 10, { expectedUrl: "https://example.com/" });
      const selection = state.selected.get(10);
      const capture = deferred();
      state.api.debugger.sendCommand.mockClear();
      state.api.debugger.sendCommand.mockReturnValueOnce(capture.promise);
      const screenshot = state.run("Page.captureScreenshot", 10);
      const queued = state.run("Input.insertText", 10, { text: "never sent" });
      await vi.advanceTimersByTimeAsync(10_000);
      expect((await screenshot).error).toContain("stays connected");
      expect((await queued).error).toContain("still running");
      expect(state.selected.get(10)).toBe(selection);
      expect(state.publications).toHaveLength(1);
      capture.resolve({ data: "late screenshot" });
      await vi.advanceTimersByTimeAsync(0);
      expect((await state.run("Runtime.evaluate", 10)).result).toEqual({});
      expect(state.api.debugger.sendCommand.mock.calls.filter(([, method]) => method === "Input.insertText")).toHaveLength(0);
      expect(state.api.debugger.detach).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("closes a tab Anbo opened once it stopped answering, and only that one", async () => {
    vi.useFakeTimers();
    try {
      const state = harness();
      await state.run("anbo.selectTab", 10, { expectedUrl: "https://example.com/" });
      expect((await state.run("anbo.openTab", 0, { url: "https://example.com/", activate: false })).result.createdByAnbo).toBe(true);
      state.api.debugger.sendCommand.mockImplementation(() => new Promise(() => {}));
      const opened = state.run("Runtime.evaluate", 12);
      const adopted = state.run("Runtime.evaluate", 10);
      await vi.advanceTimersByTimeAsync(10_000 + STUCK_MS);
      await Promise.all([opened, adopted]);
      expect(state.selected.size).toBe(0);
      expect(state.api.tabs.remove).toHaveBeenCalledExactlyOnceWith(12);
    } finally { vi.useRealTimers(); }
  });

  it("lets go of a tab that stopped answering and waits for detach before allowing reselection", async () => {
    vi.useFakeTimers();
    try {
      const state = harness();
      await state.run("anbo.selectTab", 10, { expectedUrl: "https://example.com/" });
      await state.run("anbo.selectTab", 11, { expectedUrl: "https://other.example/" });
      const capture = deferred();
      const detachment = deferred();
      state.api.debugger.sendCommand.mockClear();
      state.api.debugger.sendCommand.mockReturnValueOnce(capture.promise);
      state.api.debugger.detach.mockReturnValueOnce(detachment.promise);
      const screenshot = state.run("Page.captureScreenshot", 10);
      const queued = state.run("Input.insertText", 10, { text: "never sent" });
      await state.run("Runtime.evaluate", 11);
      await vi.advanceTimersByTimeAsync(10_000);
      expect((await screenshot).error).toContain("timed out");
      expect((await queued).error).toBeTruthy();
      expect(state.selected.has(10)).toBe(true);
      await vi.advanceTimersByTimeAsync(STUCK_MS);
      expect(state.selected.has(10)).toBe(false);
      expect(state.publications.at(-1).map((tab) => tab.id)).toEqual([11]);
      expect(state.api.debugger.detach).toHaveBeenCalledExactlyOnceWith({ tabId: 10 });
      expect((await state.run("anbo.selectTab", 10, { expectedUrl: "https://example.com/" })).error).toContain("recovering");
      expect(state.api.debugger.attach).toHaveBeenCalledTimes(2);
      detachment.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect((await state.run("anbo.selectTab", 10, { expectedUrl: "https://example.com/" })).result.id).toBe(10);
      const replacement = state.selected.get(10);
      capture.resolve({ data: "stale screenshot" });
      await vi.advanceTimersByTimeAsync(0);
      expect(state.selected.get(10)).toBe(replacement);
      expect((await state.run("Runtime.evaluate", 10)).result).toEqual({});
      expect(state.api.debugger.sendCommand.mock.calls.filter(([, method]) => method === "Input.insertText")).toHaveLength(0);
      expect(state.api.tabs.remove).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("keeps the selected transport and metadata after a bounded viewport capture timeout", async () => {
    vi.useFakeTimers();
    try {
      const state = harness();
      await state.run("anbo.selectTab", 10, { expectedUrl: "https://example.com/" });
      const selection = state.selected.get(10);
      const capture = deferred();
      state.api.debugger.sendCommand.mockReturnValueOnce(capture.promise);
      const screenshot = state.run("Page.captureScreenshot", 10, { fromSurface: true, captureBeyondViewport: false });
      await vi.advanceTimersByTimeAsync(10_000);
      expect((await screenshot).error).toContain("Tab control remains connected");
      expect(state.selected.get(10)).toBe(selection);
      expect(state.publications).toHaveLength(1);
      expect(state.api.debugger.detach).not.toHaveBeenCalled();
      expect((await state.run("Runtime.evaluate", 10)).result).toEqual({});
      expect((await state.run("Input.insertText", 10, { text: "new input" })).result).toEqual({});
      capture.resolve({ data: "late capture" });
      await vi.advanceTimersByTimeAsync(0);
      expect(state.selected.get(10)).toBe(selection);
      expect(state.api.tabs.update).not.toHaveBeenCalled();
      expect(state.api.windows.update).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});

describe("tabs a page Anbo drives opens", () => {
  // As the browser announces a tab a link opened: it names its opener, and its
  // address is still pending.
  function openedTab(state, id, extra = {}) {
    const tab = { id, title: "Next", url: "https://example.com/next", windowId: 20, status: "complete", ...extra };
    state.tabs.set(id, tab);
    return { ...tab, url: "", pendingUrl: tab.url, openerTabId: 10, active: true, ...extra };
  }

  it("connects a tab a link in the docked page opened and tells Anbo from where and how", async () => {
    const state = harness();
    await state.run("anbo.selectTab", 10, { expectedUrl: "https://example.com/" });
    const lease = state.selected.get(10).selectionId;
    state.manager.created(openedTab(state, 13), true);
    await vi.waitFor(() => expect(state.selected.has(13)).toBe(true));
    expect(state.selected.get(13)).toMatchObject({ createdByAnbo: true, openedFrom: { selectionId: lease, background: false, agent: false } });
    expect(state.publications.at(-1).map((tab) => tab.id)).toEqual([10, 13]);
    // A Ctrl or middle click: the browser opens it behind.
    state.manager.created(openedTab(state, 14, { active: false }), true);
    await vi.waitFor(() => expect(state.selected.get(14)?.openedFrom.background).toBe(true));
  });

  it("tells an agent's click from the user's by the input Anbo sent just before", async () => {
    const state = harness();
    await state.run("anbo.selectTab", 10, { expectedUrl: "https://example.com/" });
    await state.run("Runtime.evaluate", 10);
    state.manager.created(openedTab(state, 13), true);
    await vi.waitFor(() => expect(state.selected.has(13)).toBe(true));
    expect(state.selected.get(13).openedFrom.agent).toBe(false);
    // An agent's key on a tab Anbo does not show: no dock window involved.
    await state.run("Input.dispatchKeyEvent", 10, { type: "keyDown", key: "Enter" });
    state.manager.created(openedTab(state, 14));
    await vi.waitFor(() => expect(state.selected.has(14)).toBe(true));
    expect(state.selected.get(14).openedFrom.agent).toBe(true);
  });

  it("connects a tab an agent's key opened from a page behind the user's tab, and gives the user's tab back", async () => {
    // Measured in Chrome 155: Enter on a target=_blank link of a tab Anbo
    // held behind the user's tab opened the new tab in front, named the
    // user's tab as its opener, and left it in the browser.
    const state = harness();
    await state.run("anbo.selectTab", 10, { expectedUrl: "https://example.com/" });
    const lease = state.selected.get(10).selectionId;
    await state.run("Input.dispatchKeyEvent", 10, { type: "keyDown", key: "Enter" });
    state.manager.created(openedTab(state, 13, { openerTabId: 11 }));
    await vi.waitFor(() => expect(state.selected.has(13)).toBe(true));
    expect(state.selected.get(13)).toMatchObject({ openedFrom: { selectionId: lease, background: true, agent: true } });
    expect(state.api.tabs.update).toHaveBeenCalledWith(11, { active: true });
  });

  it("puts a minimized window back when an agent's key opens a tab from it", async () => {
    // Round 68 (R68-2): Chrome brought its minimized window over the user's
    // terminal for a tab an agent's Ctrl+Enter opened behind.
    const state = harness();
    await state.run("anbo.selectTab", 10, { expectedUrl: "https://example.com/" });
    let shown = "minimized";
    state.api.windows.get.mockImplementation(async (id) => ({ id, type: "normal", incognito: false, state: shown, focused: shown !== "minimized" }));
    await state.run("Input.dispatchKeyEvent", 10, { type: "keyDown", key: "Enter", modifiers: 2 });
    shown = "normal";
    state.manager.created(openedTab(state, 13, { active: false }));
    await vi.waitFor(() => expect(state.api.windows.update).toHaveBeenCalledWith(20, { state: "minimized" }));
    await vi.waitFor(() => expect(state.selected.has(13)).toBe(true));
  });

  it("sends a window back behind the user's when an agent's press opened a tab and it took the focus", async () => {
    const state = harness();
    await state.run("anbo.selectTab", 10, { expectedUrl: "https://example.com/" });
    let focused = false;
    state.api.windows.get.mockImplementation(async (id) => ({ id, type: "normal", incognito: false, state: "normal", focused }));
    await state.run("Input.dispatchMouseEvent", 10, { type: "mousePressed", x: 5, y: 5, button: "left" });
    focused = true;
    state.manager.created(openedTab(state, 13));
    await vi.waitFor(() => expect(state.api.windows.update).toHaveBeenCalledWith(20, { focused: false }));
  });

  it("leaves the window as it is for the user's own tab, or when the browser had the focus before", async () => {
    const state = harness();
    await state.run("anbo.selectTab", 10, { expectedUrl: "https://example.com/" });
    state.api.windows.get.mockImplementation(async (id) => ({ id, type: "normal", incognito: false, state: "normal", focused: true }));
    // The user's own click in the browser: no input from Anbo before it.
    state.manager.created(openedTab(state, 13), true);
    // An agent's key while the user was in the browser itself.
    await state.run("Input.dispatchKeyEvent", 10, { type: "keyDown", key: "Enter" });
    state.manager.created(openedTab(state, 14));
    await vi.waitFor(() => expect(state.selected.has(14)).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(state.api.windows.update).not.toHaveBeenCalledWith(20, { state: "minimized" });
    expect(state.api.windows.update).not.toHaveBeenCalledWith(20, { focused: false });
  });

  it("leaves to the browser a tab the user opens there from a tab Anbo holds but does not show", async () => {
    const state = harness();
    await state.run("anbo.selectTab", 10, { expectedUrl: "https://example.com/" });
    state.manager.created(openedTab(state, 13));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect([...state.selected.keys()]).toEqual([10]);
    expect(state.api.debugger.attach).toHaveBeenCalledTimes(1);
  });

  it("leaves to the browser what no driven page opened, what is no web page, and popup windows", async () => {
    const state = harness();
    await state.run("anbo.selectTab", 10, { expectedUrl: "https://example.com/" });
    state.manager.created(openedTab(state, 13, { openerTabId: 11 }), true);
    state.manager.created(openedTab(state, 14, { pendingUrl: "chrome://newtab/" }), true);
    state.manager.created(openedTab(state, 15, { windowId: 21 }), true);
    state.manager.created(openedTab(state, 16, { incognito: true }), true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect([...state.selected.keys()]).toEqual([10]);
    expect(state.api.debugger.attach).toHaveBeenCalledTimes(1);
  });

  it("does not connect a tab whose page comes after the profile disconnected", async () => {
    const state = harness();
    await state.run("anbo.selectTab", 10, { expectedUrl: "https://example.com/" });
    const announced = openedTab(state, 13);
    state.tabs.set(13, { ...state.tabs.get(13), url: "about:blank" });
    state.manager.created(announced, true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await state.manager.dispose();
    state.tabs.set(13, { ...state.tabs.get(13), url: "https://example.com/next" });
    state.api.tabs.onUpdated.emit(13, { url: "https://example.com/next" }, state.tabs.get(13));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(state.selected.has(13)).toBe(false);
    expect(state.api.debugger.attach).toHaveBeenCalledTimes(1);
  });
});
