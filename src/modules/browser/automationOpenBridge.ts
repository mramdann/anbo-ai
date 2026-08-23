import { listen } from "@tauri-apps/api/event";
import {
  BROWSER_CLOSE_REQUEST_EVENT,
  BROWSER_OPEN_REQUEST_EVENT,
  BROWSER_POPUP_REQUEST_EVENT,
  BROWSER_TABS_REQUEST_EVENT,
  type BrowserCloseRequest,
  type BrowserOpenRequest,
  type BrowserPopupRequest,
  type BrowserTabsRequest,
  createBrowserCloseListener,
  createBrowserOpenListener,
  createBrowserPopupListener,
  createBrowserTabsListener,
} from "./automationOpen";

type OpenBridge = ReturnType<typeof createBrowserOpenListener>;
type CloseBridge = ReturnType<typeof createBrowserCloseListener>;
type TabsBridge = ReturnType<typeof createBrowserTabsListener>;
type PopupBridge = ReturnType<typeof createBrowserPopupListener>;
type BrowserAutomationWindow = Window & {
  __anboBrowserOpenBridge?: OpenBridge;
  __anboBrowserCloseBridge?: CloseBridge;
  __anboBrowserTabsBridge?: TabsBridge;
  __anboBrowserPopupBridge?: PopupBridge;
};

const browserWindow = window as BrowserAutomationWindow;
const installedNewBridge =
  !browserWindow.__anboBrowserOpenBridge ||
  !browserWindow.__anboBrowserCloseBridge ||
  !browserWindow.__anboBrowserTabsBridge ||
  !browserWindow.__anboBrowserPopupBridge;
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
if (installedNewBridge) {
  window.addEventListener(
    "beforeunload",
    () => {
      openBridge.stop();
      closeBridge.stop();
      tabsBridge.stop();
      popupBridge.stop();
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
