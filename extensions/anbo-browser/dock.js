export function createDockManager(api, changed = () => {}) {
  const entries = new Map();
  let closed = false;
  let flight = Promise.resolve();
  const enqueue = (run) => { const task = flight.catch(() => {}).then(run); flight = task; return task; };

  async function removeBootstrap(entry) {
    const tab = await api.tabs.get(entry.bootstrapId).catch(() => null);
    if (tab?.windowId === entry.windowId && tab.url === entry.url && (!tab.pendingUrl || tab.pendingUrl === entry.url)) await api.tabs.remove(tab.id);
  }

  async function releaseNow(tabId, token) {
    const entry = entries.get(tabId);
    if (!entry) return {};
    if (token && entry.token !== token) throw new Error("Dock identity changed");
    entries.delete(tabId);
    try {
      const tab = await api.tabs.get(tabId).catch(() => null);
      if (tab?.windowId === entry.windowId) {
        const original = await api.windows.get(entry.originalWindow).catch(() => null);
        if (original && !original.incognito) {
          await api.tabs.move(tabId, { windowId: entry.originalWindow, index: entry.originalIndex });
        } else {
          await api.windows.update(entry.windowId, { state: "normal", focused: false });
        }
      }
    } finally {
      await removeBootstrap(entry).catch(() => {});
      if (entry.placeholderId) {
        const placeholder = await api.tabs.get(entry.placeholderId).catch(() => null);
        if (placeholder?.windowId === entry.originalWindow && placeholder.url === "about:blank" && !placeholder.pendingUrl) await api.tabs.remove(placeholder.id).catch(() => {});
      }
    }
    return {};
  }

  async function command(message, check) {
    const { tabId, selectionId, params, method } = message;
    const token = params.token;
    if (closed || !/^[a-f0-9]{64}$/.test(token ?? "")) throw new Error("Invalid dock request");
    check();
    if (method === "anbo.dockRelease") return releaseNow(tabId, token);
    if (method === "anbo.dockPrepare") {
      if (entries.size) throw new Error("Release the existing dock before docking another tab");
      const original = await api.tabs.get(tabId);
      const source = await api.windows.get(original.windowId);
      if (source.type !== "normal" || source.incognito || original.pinned || (original.groupId != null && original.groupId !== -1) || (original.splitViewId != null && original.splitViewId !== -1)) throw new Error("Preview docking requires an unpinned, ungrouped tab outside split view in a normal browser window");
      check();
      const url = api.runtime.getURL(`dock.html#${token}`);
      const window = await api.windows.create({ url, type: "normal", focused: false, width: 900, height: 700 });
      const bootstrapId = window?.tabs?.[0]?.id;
      if (!Number.isSafeInteger(window?.id) || !Number.isSafeInteger(bootstrapId)) throw new Error("Browser did not identify the dock window");
      const entry = { token, selectionId, windowId: window.id, bootstrapId, url, originalWindow: original.windowId, originalIndex: original.index ?? 0 };
      entries.set(tabId, entry);
      try {
        check();
        if (closed) throw new Error("Dock connection closed");
        return { windowId: window.id, token };
      } catch (error) { await releaseNow(tabId).catch(() => {}); throw error; }
    }
    const entry = entries.get(tabId);
    if (!entry || entry.token !== token || entry.selectionId !== selectionId) throw new Error("Dock identity changed");
    if (method !== "anbo.dockCommit") throw new Error("Unknown dock command");
    try {
      const bootstrap = await api.tabs.get(entry.bootstrapId);
      if (bootstrap.windowId !== entry.windowId || bootstrap.url !== entry.url) throw new Error("Dock window changed before attachment");
      const original = await api.tabs.get(tabId);
      if (original.windowId !== entry.originalWindow) throw new Error("Selected tab moved before docking");
      if (original.pinned || (original.groupId != null && original.groupId !== -1) || (original.splitViewId != null && original.splitViewId !== -1)) throw new Error("Selected tab grouping changed before docking");
      const siblings = await api.tabs.query({ windowId: entry.originalWindow });
      check();
      if (siblings.length === 1) {
        const placeholder = await api.tabs.create({ windowId: entry.originalWindow, url: "about:blank", active: false });
        entry.placeholderId = placeholder.id;
      }
      check();
      await api.tabs.move(tabId, { windowId: entry.windowId, index: 0 });
      check();
      await api.tabs.update(tabId, { active: true });
      await removeBootstrap(entry);
      const current = await api.tabs.query({ windowId: entry.windowId });
      if (current.length !== 1 || current[0].id !== tabId || !current[0].active) throw new Error("Dock window tabs changed before attachment");
      check();
      entry.committed = true;
      return { windowId: entry.windowId };
    } catch (error) { await releaseNow(tabId).catch(() => {}); throw error; }
  }

  function topology({ kind, tabId, windowId }) {
    for (const [selected, entry] of entries) {
      if (!entry.committed || entry.windowId !== windowId) continue;
      if ((kind === "detached" && tabId === selected) || ((kind === "created" || kind === "activated") && tabId !== selected)) {
        entry.committed = false;
        changed(selected, entry.selectionId, entry.token);
        void enqueue(() => releaseNow(selected, entry.token)).catch(() => {});
      }
    }
  }

  return { topology, ownsWindow: (windowId) => [...entries.values()].some((entry) => entry.windowId === windowId), command: (message, check) => enqueue(() => command(message, check)), release: (tabId, token) => enqueue(() => releaseNow(tabId, token)), dispose: async () => { closed = true; await flight.catch(() => {}); await Promise.allSettled([...entries.keys()].map((tabId) => releaseNow(tabId))); } };
}
