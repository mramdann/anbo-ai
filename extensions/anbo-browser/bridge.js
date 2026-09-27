const ALLOWED_DOMAINS = new Set([
  "Accessibility", "DOM", "DOMSnapshot", "Emulation", "Input", "Log",
  "Network", "Page", "Runtime", "Target",
]);
const PROFILE_METHODS = new Set(["anbo.listTabs", "anbo.openTab"]);
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
  if (!profile && !selection && !["anbo.focusTab", "anbo.dockPrepare", "anbo.dockCommit", "anbo.dockRelease"].includes(message.method) && !ALLOWED_DOMAINS.has(message.method.split(".")[0])) {
    throw new Error("Unsupported browser command domain");
  }
  if (message.method.startsWith("Target.")) {
    throw new Error("Cross-target commands are not enabled in this preview");
  }
  return message;
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
