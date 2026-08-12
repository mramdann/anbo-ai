import { listen } from "@tauri-apps/api/event";
import {
  BROWSER_CLOSE_REQUEST_EVENT,
  BROWSER_OPEN_REQUEST_EVENT,
  type BrowserCloseRequest,
  type BrowserOpenRequest,
  createBrowserCloseListener,
  createBrowserOpenListener,
} from "./automationOpen";

type OpenBridge = ReturnType<typeof createBrowserOpenListener>;
type CloseBridge = ReturnType<typeof createBrowserCloseListener>;
type BrowserAutomationWindow = Window & {
  __anboBrowserOpenBridge?: OpenBridge;
  __anboBrowserCloseBridge?: CloseBridge;
};

const browserWindow = window as BrowserAutomationWindow;
const installedNewBridge =
  !browserWindow.__anboBrowserOpenBridge ||
  !browserWindow.__anboBrowserCloseBridge;
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

if (!browserWindow.__anboBrowserOpenBridge) {
  browserWindow.__anboBrowserOpenBridge = openBridge;
}
if (!browserWindow.__anboBrowserCloseBridge) {
  browserWindow.__anboBrowserCloseBridge = closeBridge;
}
if (installedNewBridge) {
  window.addEventListener(
    "beforeunload",
    () => {
      openBridge.stop();
      closeBridge.stop();
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
