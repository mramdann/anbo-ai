import { listen } from "@tauri-apps/api/event";
import {
  BROWSER_CLOSE_REQUEST_EVENT,
  BROWSER_OPEN_REQUEST_EVENT,
  BROWSER_POPUP_REQUEST_EVENT,
  BROWSER_SHOW_REQUEST_EVENT,
  BROWSER_TABS_REQUEST_EVENT,
  BROWSER_WAKE_REQUEST_EVENT,
  type BrowserCloseRequest,
  type BrowserOpenRequest,
  type BrowserPopupRequest,
  type BrowserShowRequest,
  type BrowserTabsRequest,
  type BrowserWakeRequest,
  createBrowserCloseListener,
  createBrowserOpenListener,
  createBrowserPopupListener,
  createBrowserShowListener,
  createBrowserTabsListener,
  createBrowserWakeListener,
} from "./automationOpen";

type OpenBridge = ReturnType<typeof createBrowserOpenListener>;
type CloseBridge = ReturnType<typeof createBrowserCloseListener>;
type TabsBridge = ReturnType<typeof createBrowserTabsListener>;
type PopupBridge = ReturnType<typeof createBrowserPopupListener>;
type ShowBridge = ReturnType<typeof createBrowserShowListener>;
type WakeBridge = ReturnType<typeof createBrowserWakeListener>;
type BrowserAutomationWindow = Window & {
  __anboBrowserOpenBridge?: OpenBridge;
  __anboBrowserCloseBridge?: CloseBridge;
  __anboBrowserTabsBridge?: TabsBridge;
  __anboBrowserPopupBridge?: PopupBridge;
  __anboBrowserShowBridge?: ShowBridge;
  __anboBrowserWakeBridge?: WakeBridge;
};

const browserWindow = window as BrowserAutomationWindow;
const installedNewBridge =
  !browserWindow.__anboBrowserOpenBridge ||
  !browserWindow.__anboBrowserCloseBridge ||
  !browserWindow.__anboBrowserTabsBridge ||
  !browserWindow.__anboBrowserPopupBridge ||
  !browserWindow.__anboBrowserShowBridge ||
  !browserWindow.__anboBrowserWakeBridge;
const openBridge =
  browserWindow.__anboBrowserOpenBridge ??
  createBrowserOpenListener((handler) =>
    listen<BrowserOpenRequest>(BROWSER_OPEN_REQUEST_EVENT, ({ payload }) =>
      handler(payload),
    ),
  );
const closeBridge =
  browserWindow.__anboBrowserCloseBridge ??
  createBrowserCloseListener((handler) =>
    listen<BrowserCloseRequest>(BROWSER_CLOSE_REQUEST_EVENT, ({ payload }) =>
      handler(payload),
    ),
  );
const tabsBridge =
  browserWindow.__anboBrowserTabsBridge ??
  createBrowserTabsListener((handler) =>
    listen<BrowserTabsRequest>(BROWSER_TABS_REQUEST_EVENT, ({ payload }) =>
      handler(payload),
    ),
  );
const popupBridge =
  browserWindow.__anboBrowserPopupBridge ??
  createBrowserPopupListener((handler) =>
    listen<BrowserPopupRequest>(BROWSER_POPUP_REQUEST_EVENT, ({ payload }) =>
      handler(payload),
    ),
  );
const showBridge =
  browserWindow.__anboBrowserShowBridge ??
  createBrowserShowListener((handler) =>
    listen<BrowserShowRequest>(BROWSER_SHOW_REQUEST_EVENT, ({ payload }) =>
      handler(payload),
    ),
  );
const wakeBridge =
  browserWindow.__anboBrowserWakeBridge ??
  createBrowserWakeListener((handler) =>
    listen<BrowserWakeRequest>(BROWSER_WAKE_REQUEST_EVENT, ({ payload }) =>
      handler(payload),
    ),
  );

if (!browserWindow.__anboBrowserOpenBridge) {
  browserWindow.__anboBrowserOpenBridge = openBridge;
}
if (!browserWindow.__anboBrowserCloseBridge) {
  browserWindow.__anboBrowserCloseBridge = closeBridge;
}
if (!browserWindow.__anboBrowserTabsBridge) {
  browserWindow.__anboBrowserTabsBridge = tabsBridge;
}
if (!browserWindow.__anboBrowserPopupBridge) {
  browserWindow.__anboBrowserPopupBridge = popupBridge;
}
if (!browserWindow.__anboBrowserShowBridge) {
  browserWindow.__anboBrowserShowBridge = showBridge;
}
if (!browserWindow.__anboBrowserWakeBridge) {
  browserWindow.__anboBrowserWakeBridge = wakeBridge;
}
if (installedNewBridge) {
  window.addEventListener(
    "beforeunload",
    () => {
      openBridge.stop();
      closeBridge.stop();
      tabsBridge.stop();
      popupBridge.stop();
      showBridge.stop();
      wakeBridge.stop();
    },
    { once: true },
  );
}

export function setBrowserOpenRequestHandler(
  handler: (request: BrowserOpenRequest) => void,
) {
  openBridge.setHandler(handler);
}

export function setBrowserCloseRequestHandler(
  handler: (request: BrowserCloseRequest) => void,
) {
  closeBridge.setHandler(handler);
}

export function setBrowserTabsRequestHandler(
  handler: (request: BrowserTabsRequest) => void,
) {
  tabsBridge.setHandler(handler);
}

export function setBrowserPopupRequestHandler(
  handler: (request: BrowserPopupRequest) => void,
) {
  popupBridge.setHandler(handler);
}

export function setBrowserShowRequestHandler(
  handler: (request: BrowserShowRequest) => void,
) {
  showBridge.setHandler(handler);
}

export function setBrowserWakeRequestHandler(
  handler: (request: BrowserWakeRequest) => void,
) {
  wakeBridge.setHandler(handler);
}
