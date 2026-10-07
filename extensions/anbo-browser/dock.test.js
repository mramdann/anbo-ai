import { describe, expect, it, vi } from "vitest";
import { createDockManager } from "./dock.js";
import { validateCommand } from "./bridge.js";

const token = "a".repeat(64);
function fixture() {
  const tabs = new Map([[10, { id: 10, windowId: 20, index: 1, url: "https://example.com/" }], [11, { id: 11, windowId: 20, index: 0, url: "https://example.org/" }]]);
  const windows = new Map([[20, { id: 20, type: "normal", incognito: false }]]);
  let next = 30;
  const api = {
    runtime: { getURL: (path) => `chrome-extension://${"a".repeat(32)}/${path}` },
    tabs: {
      get: vi.fn(async (id) => { if (!tabs.has(id)) throw new Error("closed"); return { ...tabs.get(id) }; }),
      query: vi.fn(async ({ windowId }) => [...tabs.values()].filter((tab) => tab.windowId === windowId)),
      create: vi.fn(async (options) => { const tab = { id: next++, index: 0, ...options }; tabs.set(tab.id, tab); return { ...tab }; }),
      move: vi.fn(async (id, options) => { if (windows.get(tabs.get(id).windowId)?.type !== "normal" || windows.get(options.windowId)?.type !== "normal") throw new Error("Only normal windows support moving tabs"); Object.assign(tabs.get(id), options); return { ...tabs.get(id) }; }),
      update: vi.fn(async (id, options) => { Object.assign(tabs.get(id), options); return { ...tabs.get(id) }; }),
      remove: vi.fn(async (id) => { tabs.delete(id); }),
    },
    windows: {
      create: vi.fn(async ({ url, type, tabId }) => {
        if (tabId) { windows.set(41, { id: 41, type: "normal", incognito: false }); tabs.get(tabId).windowId = 41; return windows.get(41); }
        const tab = { id: next++, windowId: 40, url, index: 0 }; tabs.set(tab.id, tab); const window = { id: 40, type, incognito: false, tabs: [tab] }; windows.set(40, window); return window;
      }),
      get: vi.fn(async (id) => { if (!windows.has(id)) throw new Error("closed"); return windows.get(id); }),
      update: vi.fn(async () => ({})),
    },
  };
  const changed = vi.fn();
  const manager = createDockManager(api, changed);
  let revoked = false;
  const check = () => { if (revoked) throw new Error("revoked"); };
  const run = (method, override = {}) => manager.command({ method: `anbo.dock${method}`, tabId: 10, selectionId: "lease", params: { token }, ...override }, check);
  return { api, tabs, windows, manager, changed, run, revoke: () => { revoked = true; } };
}

describe("dedicated native dock window", () => {
  it("does not move the selected tab until the native challenge has been verified", async () => {
    const state = fixture();
    await state.run("Prepare");
    expect(state.api.tabs.move).not.toHaveBeenCalled();
    expect(state.api.windows.create).toHaveBeenCalledWith(expect.objectContaining({ type: "normal", focused: false }));
    await state.run("Commit");
    expect(state.tabs.get(10).windowId).toBe(40);
    expect(state.tabs.get(11).windowId).toBe(20);
    await state.run("Release");
    expect(state.tabs.get(10)).toMatchObject({ windowId: 20, index: 1 });
    expect(state.api.tabs.remove).not.toHaveBeenCalledWith(10);
    expect(state.api.tabs.remove).not.toHaveBeenCalledWith(11);
  });
  it("opens the dock window where Anbo will show the page", async () => {
    const state = fixture();
    await state.run("Prepare", { params: { token, bounds: { left: 203, top: -3, width: 1724, height: 924 } } });
    expect(state.api.windows.create).toHaveBeenCalledWith(expect.objectContaining({ left: 203, top: -3, width: 1724, height: 924, focused: false }));
    for (const bounds of [null, { left: 1.5, top: 0, width: 800, height: 600 }, { left: 0, top: 0, width: 0, height: 600 }, { left: 0, top: 0, width: 800 }]) {
      const other = fixture();
      await other.run("Prepare", { params: { token, bounds } });
      expect(other.api.windows.create).toHaveBeenCalledWith(expect.not.objectContaining({ left: expect.anything() }));
      expect(other.api.windows.create).toHaveBeenCalledWith(expect.objectContaining({ width: 900, height: 700 }));
    }
  });
  it("refuses a stale selection or different dock token", async () => {
    const state = fixture();
    await state.run("Prepare");
    await expect(state.run("Commit", { selectionId: "different" })).rejects.toThrow("identity");
    await expect(state.run("Release", { params: { token: "b".repeat(64) } })).rejects.toThrow("identity");
    expect(state.api.tabs.move).not.toHaveBeenCalled();
  });
  it("does not silently destroy pinned, grouped or split-view placement", async () => {
    for (const metadata of [{ pinned: true }, { groupId: 3 }, { splitViewId: 4 }]) {
      const state = fixture();
      Object.assign(state.tabs.get(10), metadata);
      await expect(state.run("Prepare")).rejects.toThrow("unpinned, ungrouped");
      expect(state.api.windows.create).not.toHaveBeenCalled();
      expect(state.api.tabs.move).not.toHaveBeenCalled();
    }
  });
  it("preserves the original window when its last tab is moved", async () => {
    const state = fixture();
    state.tabs.delete(11);
    await state.run("Prepare");
    await state.run("Commit");
    expect(state.api.tabs.create).toHaveBeenCalledWith({ windowId: 20, url: "about:blank", active: false });
    await state.run("Release");
    expect([...state.tabs.values()].filter((tab) => tab.windowId === 20)).toEqual([expect.objectContaining({ id: 10 })]);
  });
  it("never closes a placeholder the user navigated", async () => {
    const state = fixture();
    state.tabs.delete(11);
    await state.run("Prepare");
    await state.run("Commit");
    const placeholder = [...state.tabs.values()].find((tab) => tab.url === "about:blank");
    placeholder.url = "https://user.example/";
    await state.run("Release");
    expect(state.tabs.get(placeholder.id).url).toBe("https://user.example/");
  });
  it("does not close a bootstrap tab with a pending user navigation", async () => {
    const state = fixture();
    await state.run("Prepare");
    const bootstrap = [...state.tabs.values()].find((tab) => tab.windowId === 40);
    bootstrap.pendingUrl = "https://user.example/";
    await state.run("Release");
    expect(state.tabs.has(bootstrap.id)).toBe(true);
    expect(state.api.tabs.remove).not.toHaveBeenCalledWith(bootstrap.id);
  });
  it("leaves a manually moved user tab alone and does not close other tabs", async () => {
    const state = fixture();
    await state.run("Prepare");
    await state.run("Commit");
    state.tabs.get(10).windowId = 99;
    state.api.tabs.move.mockClear();
    await state.manager.dispose();
    expect(state.api.tabs.move).not.toHaveBeenCalled();
    expect(state.tabs.get(10).windowId).toBe(99);
  });
  it("moves a tab the docked page opened to the user's window and keeps the dock", async () => {
    const state = fixture();
    await state.run("Prepare");
    await state.run("Commit");
    state.tabs.set(50, { id: 50, windowId: 40, url: "https://user.example/" });
    state.manager.topology({ kind: "created", tabId: 50, windowId: 40, active: true });
    state.manager.topology({ kind: "activated", tabId: 50, windowId: 40 });
    await vi.waitFor(() => expect(state.tabs.get(50).windowId).toBe(20));
    await vi.waitFor(() => expect(state.api.tabs.update).toHaveBeenCalledWith(10, { active: true }));
    expect(state.api.tabs.update).toHaveBeenCalledWith(50, { active: true });
    expect(state.changed).not.toHaveBeenCalled();
    expect(state.tabs.get(10).windowId).toBe(40);
  });
  it("gives an opened tab its own window when the user's window is gone", async () => {
    const state = fixture();
    await state.run("Prepare");
    await state.run("Commit");
    state.windows.delete(20);
    state.tabs.set(50, { id: 50, windowId: 40, url: "https://user.example/" });
    state.manager.topology({ kind: "created", tabId: 50, windowId: 40, active: false });
    await vi.waitFor(() => expect(state.tabs.get(50).windowId).toBe(41));
    expect(state.api.windows.create).toHaveBeenCalledWith({ tabId: 50, focused: false });
    expect(state.api.tabs.update).not.toHaveBeenCalledWith(50, { active: true });
    expect(state.changed).not.toHaveBeenCalled();
  });
  it("releases the dock when another tab is shown in it instead of showing an unrelated page in Anbo", async () => {
    const state = fixture();
    await state.run("Prepare");
    await state.run("Commit");
    state.tabs.set(50, { id: 50, windowId: 40, url: "https://user.example/" });
    state.manager.topology({ kind: "activated", tabId: 50, windowId: 40 });
    expect(state.changed).toHaveBeenCalledExactlyOnceWith(10, "lease", token);
    await state.manager.dispose();
    expect(state.tabs.get(10).windowId).toBe(20);
    expect(state.tabs.get(50).windowId).toBe(40);
  });
  it("restores safely if permission is revoked during the move", async () => {
    const state = fixture();
    await state.run("Prepare");
    state.api.tabs.move.mockImplementationOnce(async (id, options) => { Object.assign(state.tabs.get(id), options); state.revoke(); });
    await expect(state.run("Commit")).rejects.toThrow("revoked");
    expect(state.tabs.get(10).windowId).toBe(20);
    expect(state.api.tabs.remove).not.toHaveBeenCalledWith(10);
  });
  it("leaves the selected page open if the original window was closed", async () => {
    const state = fixture();
    await state.run("Prepare");
    await state.run("Commit");
    state.windows.delete(20);
    await state.run("Release");
    expect(state.tabs.get(10).windowId).toBe(40);
    expect(state.api.windows.update).toHaveBeenCalledWith(40, { state: "normal", focused: false });
    expect(state.api.tabs.remove).not.toHaveBeenCalledWith(10);
  });
  it("disconnect restores the moved tab and blocks subsequent commands", async () => {
    const state = fixture();
    await state.run("Prepare");
    await state.run("Commit");
    state.revoke();
    await state.manager.dispose();
    expect(state.tabs.get(10).windowId).toBe(20);
    await expect(state.run("Prepare")).rejects.toThrow("Invalid dock request");
  });
  it("hands the dock window to another tab of the profile and sends the first page home", async () => {
    const state = fixture();
    await state.run("Prepare");
    await state.run("Commit");
    state.api.windows.create.mockClear();
    await state.run("Swap", { tabId: 11, selectionId: "other lease" });
    expect(state.api.windows.create).not.toHaveBeenCalled();
    expect(state.tabs.get(11)).toMatchObject({ windowId: 40, active: true });
    expect(state.tabs.get(10)).toMatchObject({ windowId: 20, index: 1 });
    expect(state.changed).not.toHaveBeenCalled();
    // The dock now belongs to the second tab, under its own lease.
    await expect(state.run("Release")).resolves.toEqual({});
    expect(state.tabs.get(11).windowId).toBe(40);
    await state.run("Release", { tabId: 11, selectionId: "other lease" });
    expect(state.tabs.get(11)).toMatchObject({ windowId: 20, index: 0 });
  });
  it("keeps the swap when the browser reports the tabs it moved", async () => {
    const state = fixture();
    await state.run("Prepare");
    await state.run("Commit");
    state.api.tabs.update.mockImplementationOnce(async (id, options) => {
      Object.assign(state.tabs.get(id), options);
      state.manager.topology({ kind: "activated", tabId: 11, windowId: 40 });
      return { ...state.tabs.get(id) };
    });
    state.api.tabs.move.mockImplementation(async (id, options) => {
      const from = state.tabs.get(id).windowId;
      Object.assign(state.tabs.get(id), options);
      state.manager.topology({ kind: "detached", tabId: id, windowId: from });
      return { ...state.tabs.get(id) };
    });
    await state.run("Swap", { tabId: 11, selectionId: "other lease" });
    state.manager.topology({ kind: "activated", tabId: 11, windowId: 40 });
    state.manager.topology({ kind: "detached", tabId: 10, windowId: 40 });
    expect(state.changed).not.toHaveBeenCalled();
    expect(state.tabs.get(11).windowId).toBe(40);
  });
  it("keeps the first page docked when the other tab cannot be moved", async () => {
    const state = fixture();
    await state.run("Prepare");
    await state.run("Commit");
    state.tabs.get(11).pinned = true;
    await expect(state.run("Swap", { tabId: 11 })).rejects.toThrow("unpinned, ungrouped");
    expect(state.tabs.get(10).windowId).toBe(40);
    expect(state.tabs.get(11).windowId).toBe(20);
    await expect(state.run("Swap", { tabId: 11, params: { token: "b".repeat(64) } })).rejects.toThrow("identity");
  });
  it("puts the new page back when the swap fails half way", async () => {
    const state = fixture();
    await state.run("Prepare");
    await state.run("Commit");
    state.api.tabs.move.mockImplementation(async (id, options) => {
      if (id === 10) throw new Error("tab is being dragged");
      Object.assign(state.tabs.get(id), options);
      return { ...state.tabs.get(id) };
    });
    await expect(state.run("Swap", { tabId: 11 })).rejects.toThrow("dragged");
    expect(state.tabs.get(11).windowId).toBe(20);
    expect(state.tabs.get(10)).toMatchObject({ windowId: 40, active: true });
  });
  it("keeps a window the swapped-in tab leaves empty, and the first page's placeholder goes", async () => {
    const state = fixture();
    state.tabs.delete(11);
    state.tabs.set(12, { id: 12, windowId: 21, index: 0, url: "https://example.net/" });
    state.windows.set(21, { id: 21, type: "normal", incognito: false });
    await state.run("Prepare");
    await state.run("Commit");
    const first = [...state.tabs.values()].find((tab) => tab.windowId === 20 && tab.url === "about:blank");
    await state.run("Swap", { tabId: 12 });
    expect(state.tabs.has(first.id)).toBe(false);
    expect([...state.tabs.values()].filter((tab) => tab.windowId === 21)).toEqual([expect.objectContaining({ url: "about:blank" })]);
    await state.run("Release", { tabId: 12 });
    expect([...state.tabs.values()].filter((tab) => tab.windowId === 21)).toEqual([expect.objectContaining({ id: 12 })]);
  });
  it("never grants docking control to an unselected tab", () => {
    const message = { type: "command", id: 1, tabId: 10, method: "anbo.dockPrepare", params: { token }, selectionId: "lease", expiresAt: Date.now() + 10000 };
    expect(() => validateCommand(message, new Map())).toThrow("unselected");
    expect(() => validateCommand(message, new Map([[10, { selectionId: "other" }]]))).toThrow("lease");
  });
});
