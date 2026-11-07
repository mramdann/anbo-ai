const ALLOWED_DOMAINS = new Set([
  "Accessibility", "DOM", "DOMSnapshot", "Emulation", "Input", "Log",
  "Network", "Page", "Runtime", "Target",
]);
// The profile is signed in and its cookies are its sessions, so agents drive
// its pages but never read or change them.
const COOKIE_METHODS = new Set([
  "Network.getCookies", "Network.getAllCookies", "Network.setCookie", "Network.setCookies",
  "Network.deleteCookies", "Network.clearBrowserCookies", "Page.getCookies", "Page.deleteCookie",
]);
const PROFILE_METHODS = new Set(["anbo.listTabs", "anbo.openTab", "anbo.version", "anbo.reloadExtension"]);
const TAB_METHODS = new Set(["anbo.selectTab", "anbo.releaseTab", "anbo.closeTab"]);
// Commands about the tab's place in its browser, not its page. They never wait
// behind a page command that is slow to answer.
const CONTROL_METHODS = new Set(["anbo.focusTab", "anbo.tabState", "anbo.scopeTab", "anbo.openLink", "anbo.dockPrepare", "anbo.dockCommit", "anbo.dockRelease", "anbo.dockSwap"]);
// A command past its deadline can still finish in the page, so the tab's next
// command waits for it. One still running this long after its deadline means
// the tab stopped answering, and the tab is let go, unless the browser still
// has it with Anbo's debugger on it: that page is only busy.
export const STUCK_MS = 20_000;
const TIMED_OUT = "Browser command timed out; the tab stays connected. It was not replayed and may still finish, so check the page before repeating it.";
const STILL_RUNNING = "An earlier command on this tab is still running, so this one was not sent. Check the page before trying again.";
const PROFILE_BUSY = "An earlier request to this browser profile is still running, so this one was not sent. Try again in a moment.";
const CAPTURE_TIMED_OUT = "Screenshot timed out without focusing the browser. Tab control remains connected; show the browser tab before trying another capture.";

export function validateCommand(message, attached, now = Date.now()) {
  if (!message || message.type !== "command" || !Number.isSafeInteger(message.id)
    || message.id <= 0 || !Number.isSafeInteger(message.tabId)
    || !Number.isSafeInteger(message.expiresAt) || message.expiresAt <= now
    || message.expiresAt > now + 15_000 || typeof message.method !== "string"
    || !message.params || typeof message.params !== "object" || Array.isArray(message.params)) {
    throw new Error("Invalid, expired, or unauthorized browser command");
  }
  const profile = PROFILE_METHODS.has(message.method);
  const selection = TAB_METHODS.has(message.method);
  if (["anbo.releaseTab", "anbo.closeTab"].includes(message.method) && attached.has(message.tabId) && message.selectionId !== attached.get(message.tabId).selectionId) {
    throw new Error("Tab selection lease changed; release was not replayed");
  }
  if (profile ? message.tabId !== 0 : message.tabId <= 0 || (!selection && !attached.has(message.tabId))) {
    throw new Error("Invalid or unselected browser tab");
  }
  if (!profile && !selection && (typeof message.selectionId !== "string" || !message.selectionId || message.selectionId !== attached.get(message.tabId)?.selectionId)) {
    throw new Error("Tab selection lease changed; action was not replayed");
  }
  if (COOKIE_METHODS.has(message.method)) {
    throw new Error("Cookie access is not available to agents");
  }
  if (!profile && !selection && !CONTROL_METHODS.has(message.method) && !ALLOWED_DOMAINS.has(message.method.split(".")[0])) {
    throw new Error("Unsupported browser command domain");
  }
  if (message.method.startsWith("Target.")) {
    throw new Error("Cross-target commands are not enabled in this preview");
  }
  return message;
}

// After Anbo asks the extension to reload itself, the profile connects again
// on its own within this long. A browser started later waits for the user.
export const RELOAD_RECONNECT_MS = 60_000;

/** Whether a reload Anbo asked for at `at` is recent enough for the profile
 * to connect again on its own. */
export function reconnectsAfterReload(at, now = Date.now()) {
  return Number.isSafeInteger(at) && now >= at && now - at < RELOAD_RECONNECT_MS;
}

// An empty label lets Anbo name the profile the way the browser does.
export function profileLabel(value) {
  const label = String(value ?? "").trim();
  if (label.length > 64 || /[\u0000-\u001f\u007f]/.test(label)) throw new Error("Use a profile label of up to 64 characters, or leave it empty");
  return label;
}

// The network events the bridge passes on, for Anbo's networkIdle check and
// its request list.
export const NETWORK_EVENTS = new Set(["Network.requestWillBeSent", "Network.responseReceived", "Network.loadingFinished", "Network.loadingFailed"]);

/** What Anbo gets of one network event: never headers, bodies or the timing
 * breakdown, and a URL without its user name, password or anything shaped
 * like a credential, cut at 512 characters (a data: URL can run to
 * megabytes). The event's own time lets Anbo measure a request on the
 * browser's clock, not when events arrive. */
export function networkSummary(sessionId, method, params) {
  const summary = { requestId: `${sessionId ?? ""}:${params?.requestId}` };
  if (Number.isFinite(params?.timestamp)) summary.timestamp = params.timestamp;
  if (method === "Network.requestWillBeSent") {
    summary.request = { url: listedUrl(params?.request?.url), method: String(params?.request?.method ?? "").slice(0, 16) };
    if (typeof params?.type === "string") summary.type = params.type.slice(0, 32);
    if (params?.redirectResponse) summary.redirectResponse = { status: Number(params.redirectResponse.status) || 0 };
  } else if (method === "Network.responseReceived") {
    summary.response = { status: Number(params?.response?.status) || 0 };
  } else if (method === "Network.loadingFinished") {
    summary.encodedDataLength = Number(params?.encodedDataLength) || 0;
  } else if (method === "Network.loadingFailed") {
    summary.errorText = String(params?.errorText ?? "").slice(0, 200);
    summary.canceled = params?.canceled === true;
  }
  return summary;
}

const MAX_URL = 512;
// A credential in a request URL is hidden before it leaves the browser, the
// way Anbo hides one in terminal output: a query value whose parameter is
// named like one, or any value shaped like a token or a known key.
const SECRET_WORDS = new Set(["token", "key", "secret", "password", "passwd", "pwd", "pass", "auth", "authorization", "session", "sid", "sig", "signature", "credential", "credentials", "jwt", "otp", "ticket", "apikey"]);
const SECRET_PARTS = /token|secret|passw|sess(?:ion)?id|signature|credential|api_?key|access_?key|private_?key/i;
const KEY_SHAPE = /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}|\b(?:AKIA|ASIA)[0-9A-Z]{16}\b|\bgh[opsur]_[A-Za-z0-9]{36,}|\bgithub_pat_[A-Za-z0-9_]{40,}|\bAIza[0-9A-Za-z_-]{35}|\bxox[bpsare]-[A-Za-z0-9-]{10,}|\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{24,}|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/;
const KEY_SHAPES = new RegExp(KEY_SHAPE.source, "g");

function secretName(name) {
  const words = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/);
  return words.some((word) => SECRET_WORDS.has(word)) || SECRET_PARTS.test(name);
}

// Long, unbroken, letters and digits: a token, a signature or an id.
function tokenShaped(value) {
  return KEY_SHAPE.test(value) || (value.length >= 20 && /^[A-Za-z0-9_.~=/+-]+$/.test(value) && /[A-Za-z]/.test(value) && /[0-9]/.test(value));
}

function decoded(text) {
  try {
    return decodeURIComponent(text.replace(/\+/g, " "));
  } catch {
    return text;
  }
}

function withoutCredentials(url) {
  const query = url.search
    .slice(1)
    .split("&")
    .map((part) => {
      const at = part.indexOf("=");
      if (at <= 0 || at === part.length - 1) return part;
      const name = part.slice(0, at);
      return secretName(decoded(name)) || tokenShaped(decoded(part.slice(at + 1))) ? `${name}=<REDACTED>` : part;
    });
  return `${url.protocol}//${url.host}${url.pathname.replace(KEY_SHAPES, "<REDACTED>")}${url.search ? `?${query.join("&")}` : ""}`;
}

function listedUrl(value) {
  let text = String(value ?? "");
  try {
    const url = new URL(text);
    if (/^(?:https?|wss?):$/.test(url.protocol)) {
      text = withoutCredentials(url);
    } else if (url.username || url.password) {
      url.username = "";
      url.password = "";
      text = url.href;
    }
  } catch {}
  return text.length > MAX_URL ? `${text.slice(0, MAX_URL)}...` : text;
}

export function tabInfo(tab) {
  const address = tab.url;
  if (tab.incognito || !Number.isSafeInteger(tab.id) || tab.id <= 0) {
    throw new Error("Only regular browser tabs can be selected");
  }
  if (tab.pendingUrl) webUrl(tab.pendingUrl);
  webUrl(address);
  return { id: tab.id, title: String(tab.title ?? "").slice(0, 256), url: address, loading: tab.status === "loading" };
}

export function webUrl(address) {
  if (typeof address !== "string" || !address || address.length > 8192) throw new Error("Enter an HTTP or HTTPS URL");
  const url = new URL(address);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error("Only HTTP and HTTPS tabs are supported");
  }
  return url.href;
}

/** Whether the browser still has the tab, with its page and Anbo's debugger
 * on it. A command there that is still running long past its deadline then
 * waits on a busy page (a long script), not on a tab that is gone. */
async function stillThere(api, tabId) {
  try {
    const tab = await api.tabs.get(tabId);
    if (!tab || tab.discarded === true) return false;
    const targets = await api.debugger.getTargets();
    return targets.some((target) => target.tabId === tabId && target.attached === true);
  } catch {
    return false;
  }
}

/** Resolves once `previous` does, or fails with `busy` when `expiresAt` comes first. */
function turnAfter(previous, expiresAt, busy) {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(busy)), Math.max(0, expiresAt - Date.now()));
  });
  return Promise.race([previous, late]).finally(() => clearTimeout(timer));
}

export function createDispatcher(api, attached, send, active, controls) {
  const queues = new Map();
  const captures = new Map();
  let pending = 0;
  let latestId = 0;
  return async (message) => {
    const fail = (error) => send({ type: "reply", id: message?.id, error: String(error?.message ?? error).slice(0, 2048) });
    let execute;
    let selection;
    let expired = false;
    const check = () => {
      if (expired) throw new Error(TIMED_OUT);
      validateCommand(message, attached);
      if (!active()) throw new Error("Browser connection revoked");
      if (selection && attached.get(message.tabId) !== selection) throw new Error("Tab selection revoked");
    };
    try {
      validateCommand(message, attached);
      if (!active() || pending >= 32 || message.id <= latestId) throw new Error("Browser request is unavailable, duplicated, or busy");
      latestId = message.id;
      if (PROFILE_METHODS.has(message.method) || TAB_METHODS.has(message.method)) {
        if (!controls) throw new Error("Update the Anbo browser extension to select tabs");
        execute = controls.prepare(message, check);
      } else {
        selection = attached.get(message.tabId);
      }
    } catch (error) {
      fail(error);
      return;
    }
    pending += 1;
    const lane = CONTROL_METHODS.has(message.method) ? `control:${message.tabId}` : message.tabId;
    const previous = queues.get(lane);
    let release;
    const free = new Promise((resolve) => { release = resolve; });
    queues.set(lane, free);
    // Whether the lane stays taken after the reply, for an action still running.
    let holding = false;
    const turn = previous ? turnAfter(previous, message.expiresAt, message.tabId === 0 ? PROFILE_BUSY : STILL_RUNNING) : Promise.resolve();
    const task = turn.then(async () => {
      check();
      if (execute) return await execute();
      const capture = message.method === "Page.captureScreenshot";
      const readonlyCapture = capture && message.params.fromSurface === true && message.params.captureBeyondViewport === false && !Object.hasOwn(message.params, "clip");
      if (capture && (captures.has(message.tabId) || captures.size >= 32)) throw new Error("A previous screenshot is still pending. Tab control remains connected; show the browser tab before trying another capture.");
      let timer;
      let stuck;
      let finished = false;
      // A page that only stays busy keeps its tab: the command goes on there,
      // and the tab's later commands go to the page and wait there, each up to
      // its own deadline. Letting go cost agents a tab whose page ran a long
      // script (round 70, R70-4).
      const stop = async () => {
        const gone = attached.get(message.tabId) === selection && !(await stillThere(api, message.tabId));
        if (gone && !finished && attached.get(message.tabId) === selection) {
          if (controls?.expire) controls.expire(message.tabId, selection);
          else {
            attached.delete(message.tabId);
            void api.debugger.detach({ tabId: message.tabId }).catch(() => {});
          }
        }
        release();
      };
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => {
          expired = true;
          if (!readonlyCapture) {
            stuck = setTimeout(() => void stop(), STUCK_MS);
          }
          reject(new Error(readonlyCapture ? CAPTURE_TIMED_OUT : TIMED_OUT));
        }, Math.max(0, message.expiresAt - Date.now()));
      });
      const action = (async () => {
        if (message.method === "anbo.focusTab") {
          const tab = await api.tabs.update(message.tabId, { active: true });
          check();
          await api.windows.update(tab.windowId, { focused: true });
          return {};
        }
        if (message.method === "anbo.tabState") {
          // Whether the browser shows the tab at all. While an agent's focus
          // emulation is on, a page behind another tab of its window reads as
          // visible and draws.
          const tab = await api.tabs.get(message.tabId);
          const window = await api.windows.get(tab.windowId);
          return { active: tab.active === true, split: tab.splitViewId != null && tab.splitViewId !== -1, minimized: window.state === "minimized", focused: window.focused === true };
        }
        return controls?.command ? await controls.command(message, check) : await api.debugger.sendCommand({ tabId: message.tabId }, message.method, message.params);
      })();
      if (capture) {
        captures.set(message.tabId, action);
        const complete = () => { if (captures.get(message.tabId) === action) captures.delete(message.tabId); };
        void action.then(complete, complete);
      }
      // A viewport capture changes nothing, so a late one holds nobody up.
      if (!readonlyCapture) {
        holding = true;
        const settled = () => {
          finished = true;
          clearTimeout(stuck);
          release();
        };
        void action.then(settled, settled);
      }
      try { return await Promise.race([action, deadline]); }
      finally { clearTimeout(timer); }
    });
    try {
      send({ type: "reply", id: message.id, result: (await task) ?? {} });
    } catch (error) {
      fail(error);
    } finally {
      execute?.cancel?.();
      pending -= 1;
      // A command that never ran passes the lane on only once the one before it is done.
      if (!holding) void (previous ?? Promise.resolve()).then(release);
      void free.then(() => { if (queues.get(lane) === free) queues.delete(lane); });
    }
  };
}
