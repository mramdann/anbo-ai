import { tabInfo, webUrl } from "./bridge.js";
import { createFrameTransport } from "./frames.js";
import { createDockManager } from "./dock.js";

// The version this code is, kept equal to manifest.json. After an update the
// browser reads the new manifest but can keep running the old scripts until the
// extension reloads, so the manifest alone would hide that a reload is due.
export const EXTENSION_VERSION = "0.5.2";

const MAX_TABS = 128;

export function createTabManager(api, attached, publish, dockChanged) {
  const dock = createDockManager(api, dockChanged);
  const pending = new Map();
  const attaching = new Map();
  const running = new Set();
  const owned = new Set();
  const loading = new Set();
  const transports = new Map();
  const recovering = new Map();
  let disposed = false;

  function track(task) {
    running.add(task);
    return task.finally(() => running.delete(task));
  }

  async function detach(tabId, clean = true) {
    const transport = transports.get(tabId);
    transports.delete(tabId);
    if (!clean) {
      transport?.dispose();
      try { await api.debugger.detach({ tabId }); }
      finally { owned.delete(tabId); await dock.release(tabId).catch(() => {}); }
      return;
    }
    await dock.release(tabId).catch(() => {});
    if (transport) { try { if (clean) await transport.cleanup(); } catch {} finally { transport.dispose(); } }
    await api.debugger.detach({ tabId });
    owned.delete(tabId);
  }

  function waitForPage(tabId, expiresAt, check) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer;
      const finish = (error, tab) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        api.tabs.onUpdated.removeListener(updated);
        api.tabs.onRemoved.removeListener(removed);
        loading.delete(cancel);
        if (error) reject(error); else resolve(tab);
      };
      const inspect = (tab) => {
        if (settled) return;
        try {
          check();
          if (tab.incognito || disposed) throw new Error("Browser connection revoked");
          // Wait for the first committed page. A server redirect commits
          // another address of this same new tab, which is still the page
          // asked for; tabInfo refuses anything that is not HTTP(S).
          if (!tab.url || tab.url === "about:blank") return;
          finish(null, tabInfo(tab));
        } catch (error) { finish(error); }
      };
      const updated = (changedId, _change, tab) => { if (changedId === tabId) inspect(tab); };
      const removed = (removedId) => { if (removedId === tabId) finish(new Error("The new browser tab was closed")); };
      const cancel = () => finish(new Error("Browser connection revoked"));
      loading.add(cancel);
      api.tabs.onUpdated.addListener(updated);
      api.tabs.onRemoved.addListener(removed);
      timer = setTimeout(() => finish(new Error("The new tab is still loading. Open it from Anbo's browser menu when ready.")), Math.max(0, expiresAt - Date.now()));
      void api.tabs.get(tabId).then(inspect, (error) => finish(error));
    });
  }

  function invalidate(tabId) {
    const token = pending.get(tabId);
    if (token) token.valid = false;
    pending.delete(tabId);
    const active = attaching.get(tabId);
    if (active) active.valid = false;
  }

  function reserve(tabId) {
    if (recovering.has(tabId)) throw new Error("Browser tab is recovering from a timed out command; select it again when ready");
    if (!attached.has(tabId) && attached.size + pending.size >= MAX_TABS) throw new Error("Selected tab limit reached");
    invalidate(tabId);
    const token = { valid: true };
    pending.set(tabId, token);
    return token;
  }

  async function select(tabId, expectedUrl, token, check, createdByAnbo = false) {
    const verify = () => {
      check();
      if (disposed || !token.valid) throw new Error("Tab selection revoked");
      if (recovering.has(tabId)) throw new Error("Browser tab is recovering from a timed out command; select it again when ready");
    };
    let didAttach = false;
    try {
      verify();
      const initial = await api.tabs.get(tabId);
      const before = tabInfo(initial);
      verify();
      if (before.url !== expectedUrl || (initial.pendingUrl && initial.pendingUrl !== expectedUrl)) throw new Error("This tab navigated. Refresh the tab list and select it again.");
      if (attached.has(tabId)) return { ...attached.get(tabId) };
      attaching.set(tabId, token);
      await api.debugger.attach({ tabId }, "1.3");
      didAttach = true;
      owned.add(tabId);
      verify();
      const completed = await api.tabs.get(tabId);
      const info = tabInfo(completed);
      verify();
      if (info.url !== expectedUrl || (completed.pendingUrl && completed.pendingUrl !== expectedUrl)) throw new Error("This tab navigated while connecting. Select it again.");
      info.selectionId = crypto.randomUUID();
      info.generation = 1;
      info.createdByAnbo = createdByAnbo;
      const transport = createFrameTransport(api, tabId, () => {
        const current = attached.get(tabId);
        if (current) { current.generation += 1; publish(); }
      });
      transports.set(tabId, transport);
      await transport.start();
      verify();
      const finalTab = await api.tabs.get(tabId);
      verify();
      const finalInfo = tabInfo(finalTab);
      if (finalInfo.url !== expectedUrl || (finalTab.pendingUrl && finalTab.pendingUrl !== expectedUrl)) throw new Error("This tab navigated while connecting. Select it again.");
      Object.assign(info, finalInfo);
      attached.set(tabId, info);
      publish();
      return { ...info };
    } catch (error) {
      if (didAttach) await detach(tabId).catch(() => {});
      throw error;
    } finally {
      if (pending.get(tabId) === token) pending.delete(tabId);
      if (attaching.get(tabId) === token) attaching.delete(tabId);
    }
  }

  function prepare(message, check) {
    if (disposed) throw new Error("Browser connection revoked");
    let operation;
    let cancel = () => {};
    if (message.method === "anbo.listTabs") {
      operation = async () => {
        const tabs = await api.tabs.query({ windowType: "normal" });
        check();
        const available = [];
        for (const tab of tabs) {
          try { available.push(tabInfo(tab)); } catch {}
          if (available.length === MAX_TABS) break;
        }
        return available;
      };
    } else if (message.method === "anbo.selectTab") {
      webUrl(message.params.expectedUrl);
      const token = reserve(message.tabId);
      operation = () => select(message.tabId, message.params.expectedUrl, token, check);
      cancel = () => {
        token.valid = false;
        if (pending.get(message.tabId) === token) pending.delete(message.tabId);
      };
    } else if (message.method === "anbo.releaseTab" || message.method === "anbo.closeTab") {
      const close = message.method === "anbo.closeTab" && attached.get(message.tabId)?.createdByAnbo === true;
      invalidate(message.tabId);
      if (attached.delete(message.tabId)) publish();
      const cleanup = track((async () => {
        if (owned.has(message.tabId)) await detach(message.tabId);
        if (close) { check(); await api.tabs.remove(message.tabId); }
      })());
      void cleanup.catch(() => {});
      operation = async () => {
        await cleanup;
        return { closed: close };
      };
    } else if (message.method === "anbo.openTab") {
      const url = webUrl(message.params.url);
      operation = async () => {
        if (attached.size + pending.size >= MAX_TABS) throw new Error("Selected tab limit reached");
        const windows = await api.windows.getAll({ windowTypes: ["normal"] });
        check();
        const regular = windows.filter((window) => !window.incognito && !dock.ownsWindow(window.id));
        const window = regular.find((candidate) => candidate.focused) ?? regular[0];
        if (!window) throw new Error("Open a regular window in this connected browser profile first");
        const activate = message.params.activate !== false;
        const tab = await api.tabs.create({ windowId: window.id, url, active: activate });
        check();
        const info = await waitForPage(tab.id, message.expiresAt, check);
        const result = await select(info.id, info.url, reserve(info.id), check, true);
        check();
        if (activate) await api.windows.update(window.id, { focused: true });
        return result;
      };
    } else if (message.method === "anbo.version") {
      // Anbo compares it with the files it ships, to ask for a reload after an update.
      operation = async () => ({ version: EXTENSION_VERSION });
    } else {
      throw new Error("Unknown tab selection action");
    }
    const execute = () => {
      const task = Promise.resolve().then(() => {
        check();
        if (disposed) throw new Error("Browser connection revoked");
        return operation();
      });
      return track(task);
    };
    execute.cancel = cancel;
    return execute;
  }

  function removed(tabId) {
    void dock.release(tabId).catch(() => {});
    transports.get(tabId)?.dispose();
    transports.delete(tabId);
    invalidate(tabId);
    owned.delete(tabId);
    if (attached.delete(tabId)) publish();
  }

  function expire(tabId, selection) {
    if (attached.get(tabId) !== selection) return;
    invalidate(tabId);
    attached.delete(tabId);
    publish();
    const recovery = track(detach(tabId, false)).finally(() => {
      if (recovering.get(tabId) === recovery) recovering.delete(tabId);
    });
    recovering.set(tabId, recovery);
    void recovery.catch(() => {});
  }

  function detached(tabId) {
    void dock.release(tabId).catch(() => {});
    transports.get(tabId)?.dispose();
    transports.delete(tabId);
    owned.delete(tabId);
    const token = attaching.get(tabId);
    if (token) token.valid = false;
    if (attached.delete(tabId)) publish();
  }

  function updated(tabId, change, tab) {
    const current = attached.get(tabId);
    if (!current || !("url" in change || "title" in change || "status" in change)) return;
    try {
      const next = tabInfo(tab);
      if (current.url === next.url && current.title === next.title && current.loading === next.loading) return;
      if (current.url !== next.url || (next.loading && !current.loading)) current.generation += 1;
      Object.assign(current, next);
      publish();
    } catch {
      invalidate(tabId);
      attached.delete(tabId);
      publish();
      void track(detach(tabId, false)).catch(() => {});
    }
  }

  async function dispose() {
    disposed = true;
    await dock.dispose();
    for (const cancel of [...loading]) cancel();
    for (const token of pending.values()) token.valid = false;
    pending.clear();
    const ids = [...owned];
    attached.clear();
    await Promise.allSettled([...running, ...ids.map((tabId) => detach(tabId))]);
  }

  function event(source, method, params) {
    return transports.get(source.tabId)?.event(source, method, params) ?? false;
  }

  function command(message, check) {
    if (["anbo.dockPrepare", "anbo.dockCommit", "anbo.dockRelease", "anbo.dockSwap"].includes(message.method)) return dock.command(message, check);
    const transport = transports.get(message.tabId);
    if (!transport) throw new Error("Browser tab transport unavailable");
    return transport.command(message.method, message.params);
  }

  return { prepare, removed, detached, updated, expire, dispose, publish, event, command, dockTopology: dock.topology };
}
