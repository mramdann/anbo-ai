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
      create: vi.fn(async ({ url, type }) => { const tab = { id: next++, windowId: 40, url, index: 0 }; tabs.set(tab.id, tab); const window = { id: 40, type, incognito: false, tabs: [tab] }; windows.set(40, window); return window; }),
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
  it("releases the dock when another tab is added instead of showing an unrelated page in Anbo", async () => {
    const state = fixture();
    await state.run("Prepare");
    await state.run("Commit");
    state.tabs.set(50, { id: 50, windowId: 40, url: "https://user.example/" });
    state.manager.topology({ kind: "created", tabId: 50, windowId: 40 });
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
  it("never grants docking control to an unselected tab", () => {
    const message = { type: "command", id: 1, tabId: 10, method: "anbo.dockPrepare", params: { token }, selectionId: "lease", expiresAt: Date.now() + 10000 };
    expect(() => validateCommand(message, new Map())).toThrow("unselected");
    expect(() => validateCommand(message, new Map([[10, { selectionId: "other" }]]))).toThrow("lease");
  });
});
