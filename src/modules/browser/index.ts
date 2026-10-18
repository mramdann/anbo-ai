export {
  clearBrowserAutomationActivity,
  getBrowserAutomationActivity,
  markBrowserAutomationActivity,
} from "./automationActivity";
export {
  acceptBrowserPopupRequest,
  browserPopupAfter,
  type BrowserTabMetadata,
  resolveBrowserCloseTarget,
  resolveBrowserOpenSpace,
  resolveBrowserPopupSpace,
} from "./automationOpen";
export type { BrowserPaneHandle } from "./BrowserPane";
export { BrowserStack, selectBackgroundBrowserTabs } from "./BrowserStack";
export {
  faviconUrlForPage,
  filePathToBrowserUrl,
  isBrowserPreviewablePath,
} from "./browserInput";
export {
  beginBrowserSession,
  browserEmbedClose,
  browserEmbedReconcile,
} from "./native";
