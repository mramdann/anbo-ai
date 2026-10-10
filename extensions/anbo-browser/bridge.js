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
  if (!profile && !selection && !["anbo.focusTab", "anbo.tabState", "anbo.dockPrepare", "anbo.dockCommit", "anbo.dockRelease", "anbo.dockSwap"].includes(message.method) && !ALLOWED_DOMAINS.has(message.method.split(".")[0])) {
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
      if (expired) throw new Error("Browser command timed out; select this tab again. The action was not replayed.");
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
    const previous = queues.get(message.tabId) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(async () => {
      check();
      if (execute) return await execute();
      const capture = message.method === "Page.captureScreenshot";
      const readonlyCapture = capture && message.params.fromSurface === true && message.params.captureBeyondViewport === false && !Object.hasOwn(message.params, "clip");
      if (capture && (captures.has(message.tabId) || captures.size >= 32)) throw new Error("A previous screenshot is still pending. Tab control remains connected; show the browser tab before trying another capture.");
      let timer;
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => {
          expired = true;
          if (!readonlyCapture && attached.get(message.tabId) === selection) {
            if (controls?.expire) controls.expire(message.tabId, selection);
            else {
              attached.delete(message.tabId);
              void api.debugger.detach({ tabId: message.tabId }).catch(() => {});
            }
          }
          reject(new Error(readonlyCapture
            ? "Screenshot timed out without focusing the browser. Tab control remains connected; show the browser tab before trying another capture."
            : "Browser command timed out; select this tab again. The action was not replayed."));
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
          return { active: tab.active === true, split: tab.splitViewId != null && tab.splitViewId !== -1, minimized: window.state === "minimized" };
        }
        return controls?.command ? await controls.command(message, check) : await api.debugger.sendCommand({ tabId: message.tabId }, message.method, message.params);
      })();
      if (capture) {
        captures.set(message.tabId, action);
        const complete = () => { if (captures.get(message.tabId) === action) captures.delete(message.tabId); };
        void action.then(complete, complete);
      }
      try { return await Promise.race([action, deadline]); }
      finally { clearTimeout(timer); }
    });
    queues.set(message.tabId, task);
    try {
      send({ type: "reply", id: message.id, result: (await task) ?? {} });
    } catch (error) {
      fail(error);
    } finally {
      execute?.cancel?.();
      pending -= 1;
      if (queues.get(message.tabId) === task) queues.delete(message.tabId);
    }
  };
}
