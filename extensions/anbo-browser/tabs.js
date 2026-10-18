import { tabInfo, webUrl } from "./bridge.js";
import { createFrameTransport } from "./frames.js";
import { createDockManager } from "./dock.js";

// The version this code is, kept equal to manifest.json. After an update the
// browser reads the new manifest but can keep running the old scripts until the
// extension reloads, so the manifest alone would hide that a reload is due.
export const EXTENSION_VERSION = "0.5.7";

const MAX_TABS = 128;
// A new tab opened this soon after Anbo sent input to the tab it opened from
// came from an agent's click or key, not the user's.
const AGENT_INPUT_MS = 2_000;
// How long a tab a page opened may take to reach a web page before it is left
// to the browser.
const ADOPT_WAIT_MS = 15_000;

export function createTabManager(api, attached, publishTabs, dockChanged, reload = () => {}, keepRenderers = () => {}, closedInBrowser = () => {}) {
  const dock = createDockManager(api, dockChanged);
  const pending = new Map();
  const attaching = new Map();
  const running = new Set();
  const owned = new Set();
  const loading = new Set();
  const transports = new Map();
  const recovering = new Map();
  // The renderer of each tab Anbo drives or is connecting to, by the browser's
  // own process id (webNavigation's processId, which that renderer carries as
  // --renderer-client-id). The browser runs a tab it does not show at idle
  // priority with EcoQoS, so on a busy machine each command to it waited for
  // the CPU: an open's setup took 6.7 s (Oct 14 2026). The native host keeps
  // these renderers at normal priority meanwhile.
  const renderers = new Map();
  const connecting = new Map();
  // When Anbo last sent each tab input (Input.* commands, an agent's clicks
  // and keys).
  const inputAt = new Map();
  let keptRenderers = "";
  let disposed = false;

  function publish() {
    publishTabs();
    keepDriven();
  }

  function keepDriven() {
    const ids = new Set();
    for (const [tabId, processId] of renderers) {
      if (attached.has(tabId) || connecting.has(tabId)) ids.add(processId);
      else renderers.delete(tabId);
    }
    const sorted = [...ids].sort((left, right) => left - right);
    const key = sorted.join(",");
    if (key === keptRenderers) return;
    keptRenderers = key;
    keepRenderers(sorted);
  }

  function noteRenderer(tabId, processId) {
    if (!Number.isInteger(processId) || processId <= 0 || renderers.get(tabId) === processId) return;
    renderers.set(tabId, processId);
    keepDriven();
  }

  // getFrame leaves processId out of its answer; getAllFrames includes it.
  async function learnRenderer(tabId) {
    try {
      const frames = await api.webNavigation?.getAllFrames({ tabId });
      noteRenderer(tabId, frames?.find((frame) => frame.frameId === 0)?.processId);
    } catch {}
  }

  // A navigation to another site can move the tab to another renderer.
  function committed(details) {
    if (details.frameId === 0 && (attached.has(details.tabId) || connecting.has(details.tabId))) noteRenderer(details.tabId, details.processId);
  }

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
      timer = setTimeout(() => finish(new Error("The new tab's page did not load in time.")), Math.max(0, expiresAt - Date.now()));
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

  async function select(tabId, expectedUrl, token, check, createdByAnbo = false, openedFrom = undefined) {
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
      // Before the setup below, whose commands the tab's renderer answers.
      connecting.set(tabId, token);
      await learnRenderer(tabId);
      verify();
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
      if (openedFrom) info.openedFrom = openedFrom;
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
      if (connecting.get(tabId) === token) connecting.delete(tabId);
      keepDriven();
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
      const selection = attached.get(message.tabId);
      // Anbo says whether its tab was closed on purpose, by the user or an
      // agent, which closes this one too, or only let go (moved to another
      // workspace, or its workspace went). Without that word, from an older
      // Anbo, only a tab Anbo opened closes. A tab already let go stays open.
      const wanted = typeof message.params.close === "boolean" ? message.params.close : selection?.createdByAnbo === true;
      const close = message.method === "anbo.closeTab" && selection !== undefined && wanted;
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
        let result;
        let timer;
        // The answer goes out at the deadline even while the browser is still
        // attaching; a step after it finds the open expired and stops.
        const late = new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("expired")), Math.max(0, message.expiresAt - Date.now()));
        });
        try {
          result = await Promise.race([late, (async () => {
            check();
            const info = await waitForPage(tab.id, message.expiresAt, check);
            const selected = await select(info.id, info.url, reserve(info.id), check, true);
            check();
            return selected;
          })()]);
        } catch (error) {
          // Anbo stopped waiting for this open, so nobody would ever take the
          // tab: it would stay behind in the user's browser.
          if (disposed || Date.now() < message.expiresAt) throw error;
          void track(discard(tab.id)).catch(() => {});
          throw new Error("Opening the tab took longer than Anbo waits, so the tab was closed again. Nothing was replayed; try again.");
        } finally {
          clearTimeout(timer);
        }
        if (activate) await api.windows.update(window.id, { focused: true });
        return result;
      };
    } else if (message.method === "anbo.version") {
      // Anbo compares it with the files it ships, to ask for a reload after an update.
      operation = async () => ({ version: EXTENSION_VERSION });
    } else if (message.method === "anbo.reloadExtension") {
      // An update replaced the files this code came from. The reply goes out
      // first; then the profile lets go of its tabs, reloads, and connects again.
      operation = async () => {
        reload();
        return { reloading: true };
      };
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

  async function discard(tabId) {
    invalidate(tabId);
    if (attached.delete(tabId)) publish();
    if (owned.has(tabId)) await detach(tabId).catch(() => {});
    await api.tabs.remove(tabId);
  }

  // A link, a script or a shortcut in a page Anbo drives opened a tab, from
  // where Anbo shows that page (its dock window) or after input an agent sent
  // it. It opens in Anbo too, connected the way a tab Anbo opens is, so
  // closing it in Anbo closes it here; Anbo learns which tab it came from,
  // whether the browser opened it in front, and whether an agent opened it. A
  // click the user makes in the browser itself, on a tab Anbo holds but does
  // not show, opens a tab of the browser's. So do a tab that does not start
  // out for a web page (a new tab page, an empty window a script fills) and a
  // popup window (a sign-in, which talks to its opener).
  function created(tab, fromDock = false) {
    const opener = attached.get(tab.openerTabId);
    const first = tab.pendingUrl || tab.url;
    if (disposed || !opener || tab.incognito || !Number.isSafeInteger(tab.id) || attached.has(tab.id) || pending.has(tab.id)) return;
    if ((first && !/^https?:/i.test(first)) || attached.size + pending.size >= MAX_TABS) return;
    const agent = Date.now() - (inputAt.get(opener.id) ?? Number.NEGATIVE_INFINITY) < AGENT_INPUT_MS;
    if (!fromDock && !agent) return;
    const openedFrom = { selectionId: opener.selectionId, background: tab.active !== true, agent };
    void track(adopt(tab, openedFrom)).catch(() => {});
  }

  async function adopt(tab, openedFrom) {
    const window = await api.windows.get(tab.windowId);
    if (window.type !== "normal" || window.incognito) return;
    const check = () => { if (disposed) throw new Error("Browser connection revoked"); };
    let info = await waitForPage(tab.id, Date.now() + ADOPT_WAIT_MS, check);
    // One opened in the dock window joins the user's other tabs first, so the
    // dock only ever holds the page Anbo shows.
    await dock.departure(info.id);
    // A page that moves on by itself right after its first one (a script
    // redirect) gets one more try at its new address.
    for (let attempt = 0; ; attempt += 1) {
      check();
      if (attached.has(info.id) || pending.has(info.id) || attached.size + pending.size >= MAX_TABS) return;
      try {
        await select(info.id, info.url, reserve(info.id), check, true, openedFrom);
        return;
      } catch (error) {
        if (attempt > 0) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
      info = tabInfo(await api.tabs.get(info.id));
    }
  }

  function removed(tabId, info) {
    // Closed in the browser on its own, so Anbo's tab for it closes too. Not
    // when its whole window closed, as when the browser quits: Anbo's tabs
    // then wait for the profile to come back. Anbo lets a tab go before it
    // closes one itself, so its own closes never come back here.
    const selection = attached.get(tabId);
    if (selection && info?.isWindowClosing === false) closedInBrowser(tabId, selection.selectionId);
    void dock.release(tabId).catch(() => {});
    transports.get(tabId)?.dispose();
    transports.delete(tabId);
    invalidate(tabId);
    owned.delete(tabId);
    inputAt.delete(tabId);
    if (attached.delete(tabId)) publish();
  }

  function expire(tabId, selection) {
    if (attached.get(tabId) !== selection) return;
    invalidate(tabId);
    attached.delete(tabId);
    publish();
    // A tab Anbo opened would stay behind in the browser: Anbo's tab for it
    // can no longer reach it to close it.
    const opened = selection.createdByAnbo === true;
    const recovery = track(detach(tabId, false).finally(() => (opened ? api.tabs.remove(tabId) : undefined))).finally(() => {
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
    inputAt.delete(tabId);
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
    renderers.clear();
    connecting.clear();
    inputAt.clear();
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
    if (message.method.startsWith("Input.")) inputAt.set(message.tabId, Date.now());
    return transport.command(message.method, message.params);
  }

  return { prepare, removed, detached, updated, committed, created, expire, dispose, publish, event, command, dockTopology: dock.topology };
}
