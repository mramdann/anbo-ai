import { createDispatcher, profileLabel, reconnectsAfterReload } from "./bridge.js";
import { NATIVE_HOST } from "./host.js";
import { createTabManager } from "./tabs.js";

let session = null;
let connecting = false;
let closing = null;
let error = "";

function post(message, current) {
  if (session !== current) return;
  try { current.port.postMessage(message); }
  catch (cause) {
    error = String(cause.message ?? cause);
    void disconnect();
  }
}

async function disconnect() {
  if (closing) return closing;
  const previous = session;
  session = null;
  if (!previous) return;
  try { previous.port.disconnect(); } catch {}
  closing = previous.tabs.dispose();
  try { await closing; } finally { closing = null; }
}

async function connect(name) {
  if (session || connecting || closing) throw new Error("Wait for this profile to disconnect before reconnecting");
  name = profileLabel(name);
  connecting = true;
  try {
    error = "";
    const stored = await chrome.storage.local.get("profileId");
    const profileId = stored.profileId ?? crypto.randomUUID();
    await chrome.storage.local.set({ profileId, profileName: name });
    const port = chrome.runtime.connectNative(NATIVE_HOST);
    const attached = new Map();
    const current = { port, attached, approved: false, tabs: null, label: name };
    const active = () => session === current && current.approved;
    current.tabs = createTabManager(chrome, attached, () => {
      if (active()) post({ type: "tabs", tabs: [...attached.values()] }, current);
    }, (tabId, selectionId, token) => {
      if (active()) post({ type: "event", tabId, selectionId, method: "anbo.dockReleased", params: { token } }, current);
    }, () => reloadSoon(current));
    session = current;
    const dispatch = createDispatcher(chrome, attached, (message) => post(message, current), active, current.tabs);
    port.onMessage.addListener((message) => {
      if (session !== current) return;
      if (message.type === "approved") current.approved = true;
      else if (message.type === "profile") current.label = String(message.name ?? "").slice(0, 64);
      else if (message.type === "command") void dispatch(message);
      else if (message.type === "error") { error = String(message.message); void disconnect(); }
    });
    port.onDisconnect.addListener(() => {
      const reason = chrome.runtime.lastError?.message;
      if (session !== current) return;
      error = reason ?? "Anbo disconnected. Reconnect and approve this profile again.";
      void disconnect();
    });
    port.postMessage({ version: 3, profileId, browser: navigator.userAgent.includes("Edg/") ? "edge" : "chrome", name });
  } catch (cause) {
    await disconnect();
    throw cause;
  } finally {
    connecting = false;
  }
}

// Anbo asked for it after an update. Once the reply is out, the dock and the
// tabs are let go as on a disconnect, and the reload connects again on its own.
function reloadSoon(current) {
  setTimeout(() => {
    if (session !== current) return;
    void chrome.storage.local.set({ selfReloadAt: Date.now() })
      .then(() => disconnect())
      .finally(() => chrome.runtime.reload());
  }, 50);
}

// A reload Anbo asked for connects again on its own; any other start of the
// extension waits for the user to connect the profile.
void (async () => {
  const { selfReloadAt, profileName } = await chrome.storage.local.get(["selfReloadAt", "profileName"]);
  if (selfReloadAt === undefined) return;
  await chrome.storage.local.remove("selfReloadAt");
  if (reconnectsAfterReload(selfReloadAt)) await connect(profileName ?? "");
})().catch((cause) => { error = String(cause?.message ?? cause); });

chrome.debugger.onDetach.addListener(({ tabId }) => session?.tabs.detached(tabId));
chrome.debugger.onEvent.addListener((source, method, params) => {
  const current = session;
  const tab = current?.attached.get(source.tabId);
  if (!current?.approved || !current.tabs.event(source, method, params) || !tab) return;
  if (method === "Page.frameNavigated" && !source.sessionId && !params.frame.parentId) {
    post({ type: "event", tabId: tab.id, selectionId: tab.selectionId, method, params: {} }, current);
  } else if (["Network.requestWillBeSent", "Network.loadingFinished", "Network.loadingFailed"].includes(method)) {
    post({ type: "event", tabId: tab.id, selectionId: tab.selectionId, method, params: { requestId: `${source.sessionId ?? ""}:${params.requestId}` } }, current);
  } else if (method === "Runtime.consoleAPICalled" || method === "Runtime.exceptionThrown") {
    const msg = method === "Runtime.exceptionThrown" ? String(params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text ?? "Page exception") : (params.args ?? []).slice(0, 10).map((arg) => String(arg.value ?? arg.description ?? arg.type ?? "").slice(0, 1024)).join(" ");
    post({ type: "event", tabId: tab.id, selectionId: tab.selectionId, method: "anbo.console", params: { level: method === "Runtime.exceptionThrown" ? "error" : String(params.type).slice(0, 16), msg: msg.slice(0, 4000), ts: Math.round(params.timestamp ?? Date.now()), frame: source.sessionId ? `frame-${source.sessionId}` : "main" } }, current);
  } else if (method === "Runtime.bindingCalled" && params.name === "__anboDesignPost" && typeof params.payload === "string" && params.payload.length <= 320 * 1024) {
    post({ type: "event", tabId: tab.id, selectionId: tab.selectionId, method, params }, current);
  }
});
chrome.tabs.onRemoved.addListener((tabId) => session?.tabs.removed(tabId));
chrome.tabs.onUpdated.addListener((tabId, change, tab) => session?.tabs.updated(tabId, change, tab));
chrome.tabs.onCreated.addListener((tab) => session?.tabs.dockTopology({ kind: "created", tabId: tab.id, windowId: tab.windowId, active: tab.active }));
chrome.tabs.onDetached.addListener((tabId, info) => session?.tabs.dockTopology({ kind: "detached", tabId, windowId: info.oldWindowId }));
chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  const current = session;
  current?.tabs.dockTopology({ kind: "activated", tabId, windowId });
  const tab = current?.attached.get(tabId);
  if (current?.approved && tab) post({ type: "event", tabId, selectionId: tab.selectionId, method: "anbo.visible", params: {} }, current);
});

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL("popup.html") || sender.tab) return false;
  void (async () => {
    if (message.type === "connect") await connect(message.name);
    else if (message.type === "disconnect") await disconnect();
    else if (message.type !== "status") throw new Error("Choose tabs directly inside Anbo");
    const stored = await chrome.storage.local.get("profileName");
    return { connected: Boolean(session), approved: session?.approved ?? false, busy: connecting || Boolean(closing), error, name: stored.profileName ?? "", label: session?.label ?? "", selected: session?.attached.size ?? 0 };
  })().then((result) => respond({ ok: true, result }), (cause) => respond({ ok: false, error: String(cause.message ?? cause) }));
  return true;
});
