import { tabInfo, webUrl } from "./bridge.js";
import { createFrameTransport } from "./frames.js";
import { createDockManager } from "./dock.js";

// The version this code is, kept equal to manifest.json. After an update the
// browser reads the new manifest but can keep running the old scripts until the
// extension reloads, so the manifest alone would hide that a reload is due.
export const EXTENSION_VERSION = "0.5.17";

const MAX_TABS = 128;
// A new tab opened this soon after Anbo sent input to the tab it opened from
// came from an agent's click or key, not the user's.
const AGENT_INPUT_MS = 2_000;
// Input to tabs of two workspaces closer together than this leaves Anbo unable
// to tell which one opened a tab: a page opens one tens of milliseconds after
// the key or click that opened it.
const SHARED_INPUT_GAP_MS = 500;
// How long such a tab waits for the browser to name the page its navigation
// came from (webNavigation.onCreatedNavigationTarget), which it does a moment
// after the tab, or before.
const SOURCE_WAIT_MS = 400;
// How long, after a tab an agent's input opened, its window is watched to put
// it back the way it was, and how often it is looked at meanwhile: the browser
// brought it up about 60 ms after the key (Oct 28 2026). Looked at 0, 25, 50,
// 100, 200, 400, 800 and 1,500 ms after the tab came, a minimized window
// stayed in front of the user's for 0.13 to 0.49 s, 23 times for 32 such tabs
// (round 72, R72-1). The browser's word that the window took the focus or
// moved has it looked at at once.
const KEEP_WINDOW_MS = 1_500;
const KEEP_WINDOW_LOOK_MS = 25;
// How long a tab a page opened may take to reach a web page before it is left
// to the browser.
const ADOPT_WAIT_MS = 15_000;
// How long after an agent's input its window is still put back for a tab that
// input's page opened. On a busy machine such a tab came 2.4 s after the key,
// past AGENT_INPUT_MS, and its minimized window stayed in front of the user's
// until another agent's tab happened to put it back (round 94, R92-1); in
// round 92 nothing did, twice, for 94 minutes in all. A window noted
// minimized this long ago was not brought up by the user in between, short of
// restoring it and following a link on the very page the agent works in.
const KEEP_AFTER_INPUT_MS = 10_000;
// For Anbo's log only: how long after a watch that saw nothing its window is
// noted coming up (round 92, R92-1).
const LATE_NOTE_MS = 15_000;

export function createTabManager(api, attached, publishTabs, dockChanged, reload = () => {}, keepRenderers = () => {}, closedInBrowser = () => {}, note = () => {}) {
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
  // Each such tab's window as it was right before an agent's key or press:
  // { windowId, state, focused, at }.
  const windowBefore = new Map();
  // The windows being put back (keepWindow), each with its watches' wake-ups.
  const keeping = new Map();
  // The windows a watch left as they were, for a note if they come up after.
  const watched = new Map();
  // The workspace of each tab Anbo holds, as an opaque name Anbo gives it, with
  // the selection it was given for. One profile can serve several workspaces.
  const scopes = new Map();
  // The page each new tab's navigation came from, as the browser names it
  // (onCreatedNavigationTarget's sourceTabId), and the tabs waiting for it.
  // Unlike openerTabId, which names the tab in front of its window for a tab a
  // key opened, it names the page the key or click reached.
  const sources = new Map();
  const sourceWaits = new Map();
  // The tabs anbo.openTab is making, each { windowId, url, tabId } until its
  // open is over: the browser tells of a new tab around the time it answers
  // the call that made it.
  const opening = new Set();
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
      scopes.delete(message.tabId);
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
        const own = { windowId: window.id, url, tabId: undefined };
        opening.add(own);
        let tab;
        try {
          tab = await api.tabs.create({ windowId: window.id, url, active: activate });
          own.tabId = tab.id;
        } catch (error) {
          opening.delete(own);
          throw error;
        }
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
          opening.delete(own);
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
  const driven = (tabId) => Date.now() - (inputAt.get(tabId) ?? Number.NEGATIVE_INFINITY) < AGENT_INPUT_MS;

  // The workspace Anbo named for a selection; empty from an Anbo that names none.
  function scopeOf(selection) {
    const named = scopes.get(selection.id);
    return named?.selectionId === selection.selectionId ? named.scope : "";
  }

  // The tab Anbo holds that an agent's input reached last, within the moment
  // a page takes to open a tab, and the workspaces of all the tabs input
  // reached in that moment.
  function lastDriven() {
    let found = null;
    let at = Number.NEGATIVE_INFINITY;
    const workspaces = new Set();
    for (const [tabId, selection] of attached) {
      if (!driven(tabId)) continue;
      workspaces.add(scopeOf(selection));
      const input = inputAt.get(tabId);
      if (input > at) [found, at] = [selection, input];
    }
    return { found, workspaces };
  }

  // Whether a tab of another workspace had input after this tab's last, or
  // too little before it to tell the two apart.
  function contested(selection) {
    const scope = scopeOf(selection);
    const from = inputAt.get(selection.id) - SHARED_INPUT_GAP_MS;
    return [...attached].some(([tabId, other]) => tabId !== selection.id && driven(tabId) && scopeOf(other) !== scope && inputAt.get(tabId) >= from);
  }

  // Whether a new tab is one anbo.openTab is making: by its id once the browser
  // answered that call, before that by its window and address.
  function ownOpen(tab) {
    for (const own of opening) {
      if (own.tabId === undefined ? own.windowId === tab.windowId && !Number.isSafeInteger(tab.openerTabId) && own.url === (tab.pendingUrl || tab.url) : own.tabId === tab.id) return true;
    }
    return false;
  }

  function created(tab, fromDock = false) {
    // Anbo's own new tab is no page's. One made for an agent while another
    // agent's tab had input was taken for a tab that input opened: its window
    // was watched for 1.5 s to be put back (an open that brings the window up,
    // as with activate, would have it put away again), and "a tab came and its
    // window is not put back" was noted with no page opening anything (round
    // 94, R94-2: three times in 1,662 loops of two agents).
    if (ownOpen(tab)) return;
    const opener = attached.get(tab.openerTabId);
    const named = Boolean(opener && driven(opener.id));
    const recent = fromDock ? null : lastDriven();
    if (recent && !recent.found) void track(keepLate(tab)).catch(() => {});
    // Agents of two workspaces sent input in the moment a page takes to open a
    // tab. The opener, the one the browser named or else the tab input reached
    // last, holds when the other workspace's input came well before its own.
    // Closer than that, the browser's opener could be either one's (below), as
    // when the other tab's key opened it, so the tab could land in the wrong
    // workspace: it stays the browser's, and only its window goes back.
    if (recent && recent.workspaces.size > 1 && contested(named ? opener : recent.found)) {
      const source = [...attached.keys()].find((id) => driven(id) && windowBefore.get(id)?.windowId === tab.windowId);
      if (!disposed && !tab.incognito && source !== undefined) void keepWindow(source, tab.windowId).catch(() => {});
      // The browser then says which page the navigation came from: the tab
      // goes to that page's workspace when Anbo drives it. Round 78 in Dev:
      // without this, 4 of 17 tabs agents' clicks opened stayed in Chrome
      // while two workspaces' agents worked on one profile.
      void track(adoptFromSource(tab)).catch(() => {});
      return;
    }
    // The browser names the tab in front of its window as a new tab's opener,
    // so one it names for no page Anbo drives may still come from an agent's
    // key on a page Anbo holds behind the user's tab, as in a workspace Anbo
    // is not showing. Only the browser's word on the page its navigation came
    // from tells that apart from the user's own new tab or link while an agent
    // works: the tab input reached last, the guess before, gave 4 of 10 tabs
    // the user opened in their own window to agents' workspaces (round 78).
    if (recent?.found && !named) {
      if (!disposed && !tab.incognito) void keepWindow(recent.found.id, tab.windowId).catch(() => {});
      void track(adoptFromSource(tab)).catch(() => {});
      return;
    }
    const first = tab.pendingUrl || tab.url;
    if (disposed || !opener || tab.incognito || !Number.isSafeInteger(tab.id) || attached.has(tab.id) || pending.has(tab.id)) return;
    const agent = driven(opener.id);
    if (agent && !fromDock) void keepWindow(opener.id, tab.windowId).catch(() => {});
    if ((first && !/^https?:/i.test(first)) || attached.size + pending.size >= MAX_TABS) return;
    if (!fromDock && !agent) return;
    const openedFrom = { selectionId: opener.selectionId, background: tab.active !== true, agent };
    void track(adopt(tab, openedFrom)).catch(() => {});
  }

  // A tab that came after the moment input counts as an agent's. The browser's
  // word on the page its navigation came from tells one that page opened late
  // from the user's own new tab, which names none: the page's window goes back
  // as for a tab in time, and the tab itself stays the browser's.
  async function keepLate(tab) {
    const source = await sourceOf(tab.id);
    sources.delete(tab.id);
    const at = inputAt.get(source);
    if (disposed || tab.incognito || !attached.has(source) || at === undefined) return;
    const age = Date.now() - at;
    if (age >= KEEP_AFTER_INPUT_MS) return;
    note(source, `a tab came ${age} ms after the last input to this page, past the ${AGENT_INPUT_MS} ms an agent's tab has: it stays the browser's, and its window is put back`);
    await keepWindow(source, tab.windowId);
  }

  function navigationTarget(details) {
    if (disposed || !Number.isSafeInteger(details?.tabId) || !Number.isSafeInteger(details?.sourceTabId)) return;
    sources.set(details.tabId, details.sourceTabId);
    if (sources.size > MAX_TABS) sources.delete(sources.keys().next().value);
    sourceWaits.get(details.tabId)?.();
  }

  // The page a new tab's navigation came from, once the browser names it.
  function sourceOf(tabId) {
    if (sources.has(tabId)) return Promise.resolve(sources.get(tabId));
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        sourceWaits.delete(tabId);
        resolve(sources.get(tabId));
      };
      const timer = setTimeout(done, SOURCE_WAIT_MS);
      sourceWaits.set(tabId, done);
    });
  }

  // A tab whose opener Anbo cannot tell (input to two workspaces' tabs could
  // have opened it, or the browser named no page Anbo drives) goes to the page
  // the browser says its navigation came from, when Anbo drives it; without
  // that word it stays the browser's.
  async function adoptFromSource(tab) {
    const source = attached.get(await sourceOf(tab.id));
    sources.delete(tab.id);
    if (disposed || !source || !driven(source.id) || tab.incognito || !Number.isSafeInteger(tab.id)) return;
    if (attached.has(tab.id) || pending.has(tab.id) || attached.size + pending.size >= MAX_TABS) return;
    const first = tab.pendingUrl || tab.url;
    if (first && !/^https?:/i.test(first)) return;
    // It came in front of the tab the browser named: that one gets its place
    // back, as for a key on a page held behind the user's tab.
    const front = tab.active === true && Number.isSafeInteger(tab.openerTabId) && tab.openerTabId !== source.id ? tab.openerTabId : null;
    await adopt(tab, { selectionId: source.selectionId, background: tab.active !== true || front !== null, agent: true }, front);
  }

  // The browser brings a minimized window back, and in front of the window the
  // user is in, for a tab a page in it opens, even one it opens behind
  // (Ctrl+Enter): the user's terminal lost the foreground to Chrome 8 of 8
  // times, also over the browser's own CDP without Anbo (round 68, R68-2), and
  // 18 of 18 in round 85. A link goes through openLink instead; what is left
  // here is a page's own window.open, a form with a target, and a link a page's
  // handler kept from Anbo. The window an agent's input made a tab in goes back
  // to how it was before that input: minimized again, or behind the window it
  // came over. Anbo's dock window is Anbo's to show.
  async function keepWindow(openerId, windowId) {
    const before = windowBefore.get(openerId);
    const since = Date.now();
    if (!before || before.windowId !== windowId || since - before.at > KEEP_AFTER_INPUT_MS) {
      const why = !before ? "no window was noted before the input" : before.windowId !== windowId ? "it came in another window" : `its window was noted ${since - before.at} ms before, past ${KEEP_AFTER_INPUT_MS} ms`;
      note(openerId, `a tab came and its window is not put back: ${why}`);
      return;
    }
    if (dock.ownsWindow(windowId) || (before.state !== "minimized" && before.focused)) return;
    watched.delete(windowId);
    const watch = { wake: () => {} };
    const watches = keeping.get(windowId) ?? new Set();
    keeping.set(windowId, watches.add(watch));
    try {
      for (const until = Date.now() + KEEP_WINDOW_MS; !disposed; ) {
        const window = await api.windows.get(windowId).catch(() => null);
        if (!window || disposed) return;
        if (before.state === "minimized" && window.state !== "minimized") {
          await api.windows.update(windowId, { state: "minimized" });
          note(openerId, `its window came up for a new tab and was minimized again ${Date.now() - since} ms after the tab`);
          return;
        }
        if (before.state !== "minimized" && window.focused === true) {
          await api.windows.update(windowId, { focused: false });
          note(openerId, `its window took the focus for a new tab and was sent behind ${Date.now() - since} ms after the tab`);
          return;
        }
        const left = until - Date.now();
        if (left <= 0) {
          watched.set(windowId, { openerId, before, since });
          return;
        }
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, Math.min(KEEP_WINDOW_LOOK_MS, left));
          watch.wake = () => { clearTimeout(timer); resolve(); };
        });
      }
    } finally {
      watches.delete(watch);
      if (watches.size === 0 && keeping.get(windowId) === watches) keeping.delete(windowId);
    }
  }

  // A link an agent followed on a page in a window away from the user: a tab a
  // page opens brings that window back, 18 of 18 times in round 85, and one
  // made here leaves it as it is. It is the page's all the same: its window,
  // the page as its opener, and the page its navigation came from, so it goes
  // to that page's workspace.
  async function openLink(message, check) {
    const url = webUrl(message.params.url);
    const source = await api.tabs.get(message.tabId);
    check();
    inputAt.set(message.tabId, Date.now());
    const tab = await api.tabs.create({ windowId: source.windowId, url, active: false, openerTabId: source.id });
    navigationTarget({ tabId: tab.id, sourceTabId: source.id });
    return { tabId: tab.id };
  }

  // The browser says a window took the focus or moved: one being put back is
  // looked at now, not at its next look.
  function windowChanged(windowId) {
    for (const watch of keeping.get(windowId) ?? []) watch.wake();
    if (watched.has(windowId)) void lateLook(windowId).catch(() => {});
  }

  // A window that comes up once its watch is over stays there. Only noted.
  async function lateLook(windowId) {
    const late = watched.get(windowId);
    if (Date.now() - late.since > LATE_NOTE_MS) {
      watched.delete(windowId);
      return;
    }
    const window = await api.windows.get(windowId).catch(() => null);
    if (!window || disposed || watched.get(windowId) !== late) return;
    if (late.before.state === "minimized" ? window.state === "minimized" : window.focused !== true) return;
    watched.delete(windowId);
    note(late.openerId, `its window came up ${Date.now() - late.since} ms after a new tab, past the ${KEEP_WINDOW_MS} ms it is watched, and stays there`);
  }

  async function adopt(tab, openedFrom, front = null) {
    // The user's tab gets the front of their window back.
    if (front !== null) await api.tabs.update(front, { active: true }).catch(() => {});
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
    windowBefore.delete(tabId);
    scopes.delete(tabId);
    sources.delete(tabId);
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
    windowBefore.delete(tabId);
    scopes.delete(tabId);
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
      // The generation moves on for a new document of the top frame, which the
      // tab's debugger session reports (frames.js). Not for a loading status,
      // which an iframe's own load sets too, nor for an address a single-page
      // app changes within its document: refs outlive both, as in Anbo's own
      // browser (round 72, R72-5).
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
    windowBefore.clear();
    scopes.clear();
    sources.clear();
    for (const done of [...sourceWaits.values()]) done();
    for (const watches of keeping.values()) for (const watch of watches) watch.wake();
    keeping.clear();
    watched.clear();
    const ids = [...owned];
    attached.clear();
    await Promise.allSettled([...running, ...ids.map((tabId) => detach(tabId))]);
  }

  function event(source, method, params) {
    return transports.get(source.tabId)?.event(source, method, params) ?? false;
  }

  // Where an agent's key or press begins.
  function startsInput(message) {
    const type = message.params?.type;
    return (message.method === "Input.dispatchKeyEvent" && (type === "keyDown" || type === "rawKeyDown")) || (message.method === "Input.dispatchMouseEvent" && type === "mousePressed");
  }

  // The window an agent's input may make a tab in, as it is before that input.
  async function noteWindow(tabId) {
    try {
      const tab = await api.tabs.get(tabId);
      const window = await api.windows.get(tab.windowId);
      windowBefore.set(tabId, { windowId: window.id, state: window.state, focused: window.focused === true, at: Date.now() });
    } catch {
      windowBefore.delete(tabId);
    }
  }

  function command(message, check) {
    if (["anbo.dockPrepare", "anbo.dockCommit", "anbo.dockRelease", "anbo.dockSwap"].includes(message.method)) return dock.command(message, check);
    if (message.method === "anbo.scopeTab") {
      const scope = message.params.scope;
      if (typeof scope !== "string" || !/^[a-f0-9]{1,64}$/.test(scope)) throw new Error("Invalid workspace scope");
      scopes.set(message.tabId, { selectionId: message.selectionId, scope });
      return {};
    }
    if (message.method === "anbo.openLink") return openLink(message, check);
    const transport = transports.get(message.tabId);
    if (!transport) throw new Error("Browser tab transport unavailable");
    if (message.method.startsWith("Input.")) {
      inputAt.set(message.tabId, Date.now());
      if (startsInput(message)) {
        return noteWindow(message.tabId).then(() => {
          check();
          return transport.command(message.method, message.params);
        });
      }
    }
    return transport.command(message.method, message.params);
  }

  return { prepare, removed, detached, updated, committed, created, navigationTarget, expire, dispose, publish, event, command, windowChanged, dockTopology: dock.topology };
}
