// Where Anbo will show the page, so the window opens behind Anbo rather than
// wherever the browser would place a new window.
function openingBounds(bounds) {
  const place = bounds && [bounds.left, bounds.top].every((value) => Number.isSafeInteger(value) && Math.abs(value) <= 32_768);
  const size = bounds && [bounds.width, bounds.height].every((value) => Number.isSafeInteger(value) && value >= 100 && value <= 16_384);
  return place && size ? { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height } : { width: 900, height: 700 };
}

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

  // Another tab of the profile takes the docked page's place in the same dock
  // window. The window stays where Anbo shows it, so the panel never goes blank
  // and no new window opens; the page shown before goes back to its own window.
  async function swap(tabId, selectionId, token, check) {
    const found = [...entries].find(([, entry]) => entry.token === token);
    if (!found || found[0] === tabId || !found[1].committed) throw new Error("Dock identity changed");
    const [previous, entry] = found;
    const original = await api.tabs.get(tabId);
    const source = await api.windows.get(original.windowId);
    if (original.windowId === entry.windowId || source.type !== "normal" || source.incognito || original.pinned || (original.groupId != null && original.groupId !== -1) || (original.splitViewId != null && original.splitViewId !== -1)) throw new Error("Preview docking requires an unpinned, ungrouped tab outside split view in a normal browser window");
    check();
    // Both tabs change windows here; that is the swap, not a reason to release.
    entry.moving.add(tabId);
    entry.moving.add(previous);
    let placeholderId;
    try {
      const siblings = await api.tabs.query({ windowId: original.windowId });
      if (siblings.length === 1) placeholderId = (await api.tabs.create({ windowId: original.windowId, url: "about:blank", active: false })).id;
      check();
      await api.tabs.move(tabId, { windowId: entry.windowId, index: 0 });
      await api.tabs.update(tabId, { active: true });
      const back = await api.windows.get(entry.originalWindow).catch(() => null);
      if (back && !back.incognito) await api.tabs.move(previous, { windowId: entry.originalWindow, index: entry.originalIndex });
      else await api.windows.create({ tabId: previous, focused: false });
      if (entry.placeholderId) {
        const placeholder = await api.tabs.get(entry.placeholderId).catch(() => null);
        if (placeholder?.windowId === entry.originalWindow && placeholder.url === "about:blank" && !placeholder.pendingUrl) await api.tabs.remove(placeholder.id).catch(() => {});
      }
      const current = await api.tabs.query({ windowId: entry.windowId });
      if (current.length !== 1 || current[0].id !== tabId || !current[0].active) throw new Error("Dock window tabs changed during the swap");
      check();
      entries.delete(previous);
      entries.set(tabId, { ...entry, selectionId, originalWindow: original.windowId, originalIndex: original.index ?? 0, placeholderId, moving: new Set(), committed: true });
      return { windowId: entry.windowId };
    } catch (error) {
      // The page shown before keeps the dock; the new page goes back where it was.
      const moved = await api.tabs.get(tabId).catch(() => null);
      if (moved?.windowId === entry.windowId) await api.tabs.move(tabId, { windowId: original.windowId, index: original.index ?? -1 }).catch(() => {});
      if (placeholderId) await api.tabs.remove(placeholderId).catch(() => {});
      const kept = await api.tabs.get(previous).catch(() => null);
      if (kept?.windowId === entry.windowId) await api.tabs.update(previous, { active: true }).catch(() => {});
      throw error;
    } finally {
      entry.moving.delete(tabId);
      entry.moving.delete(previous);
    }
  }

  async function command(message, check) {
    const { tabId, selectionId, params, method } = message;
    const token = params.token;
    if (closed || !/^[a-f0-9]{64}$/.test(token ?? "")) throw new Error("Invalid dock request");
    check();
    if (method === "anbo.dockRelease") return releaseNow(tabId, token);
    if (method === "anbo.dockSwap") return swap(tabId, selectionId, token, check);
    if (method === "anbo.dockPrepare") {
      if (entries.size) throw new Error("Release the existing dock before docking another tab");
      const original = await api.tabs.get(tabId);
      const source = await api.windows.get(original.windowId);
      if (source.type !== "normal" || source.incognito || original.pinned || (original.groupId != null && original.groupId !== -1) || (original.splitViewId != null && original.splitViewId !== -1)) throw new Error("Preview docking requires an unpinned, ungrouped tab outside split view in a normal browser window");
      check();
      const url = api.runtime.getURL(`dock.html#${token}`);
      const window = await api.windows.create({ url, type: "normal", focused: false, ...openingBounds(params.bounds) });
      const bootstrapId = window?.tabs?.[0]?.id;
      if (!Number.isSafeInteger(window?.id) || !Number.isSafeInteger(bootstrapId)) throw new Error("Browser did not identify the dock window");
      const entry = { token, selectionId, windowId: window.id, bootstrapId, url, originalWindow: original.windowId, originalIndex: original.index ?? 0, moving: new Set() };
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

  // A link or shortcut opened a tab in the dock window. It joins the user's other
  // tabs, so the docked page stays in Anbo and no unrelated page stays there.
  async function moveOut(selected, entry, tabId, active) {
    try {
      const original = await api.windows.get(entry.originalWindow).catch(() => null);
      if (original && !original.incognito) await api.tabs.move(tabId, { windowId: entry.originalWindow, index: -1 });
      else await api.windows.create({ tabId, focused: false });
      if (active) await api.tabs.update(tabId, { active: true });
      if (entries.get(selected) === entry) await api.tabs.update(selected, { active: true });
    } finally {
      entry.moving.delete(tabId);
    }
  }

  function topology({ kind, tabId, windowId, active }) {
    for (const [selected, entry] of entries) {
      if (!entry.committed || entry.windowId !== windowId || entry.moving.has(tabId)) continue;
      if (kind === "created" && tabId !== selected) {
        entry.moving.add(tabId);
        void moveOut(selected, entry, tabId, active).catch(() => {});
        continue;
      }
      if ((kind === "detached" && tabId === selected) || (kind === "activated" && tabId !== selected)) {
        entry.committed = false;
        changed(selected, entry.selectionId, entry.token);
        void enqueue(() => releaseNow(selected, entry.token)).catch(() => {});
      }
    }
  }

  return { topology, ownsWindow: (windowId) => [...entries.values()].some((entry) => entry.windowId === windowId), command: (message, check) => enqueue(() => command(message, check)), release: (tabId, token) => enqueue(() => releaseNow(tabId, token)), dispose: async () => { closed = true; await flight.catch(() => {}); await Promise.allSettled([...entries.keys()].map((tabId) => releaseNow(tabId))); } };
}
