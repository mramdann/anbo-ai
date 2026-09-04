import { emitTo, listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";

/**
 * Where a link found in content — an agent's terminal output, a markdown
 * preview — should open. Anbo has a browser of its own, so leaving the app for
 * every link means losing the workspace it belongs to, and making Anbo the
 * system default browser is far too big a change to ask for in return.
 *
 * Everything a click can reach goes through here, wherever it is shown. The
 * one deliberate exception is the address bar's "Open in system browser",
 * which exists precisely to leave.
 */
const OPEN_LINK_EVENT = "anbo:open-link";
const MAIN_WINDOW = "main";
type InAppOpener = (url: string) => void;

let inAppOpener: InAppOpener | null = null;
let preferInApp = true;

/** Registered once by the app shell, which is the only thing that owns tabs. */
export function setInAppLinkOpener(open: InAppOpener | null): void {
  inAppOpener = open;
}

export function setPreferInAppLinks(value: boolean): void {
  preferInApp = value;
}

/**
 * Whether the embedded browser can and should take this link.
 *
 * Scheme is the deciding factor: a tab can show http and https, while
 * `mailto:`, `file:` and everything else belong to whatever the system has
 * registered for them. A link the browser cannot render is worse than one that
 * leaves the app.
 */
export function shouldOpenInAnbo(url: string, prefer: boolean): boolean {
  if (!prefer) return false;
  try {
    const protocol = new URL(url).protocol.toLowerCase();
    return protocol === "http:" || protocol === "https:";
  } catch {
    // Not a URL we can reason about; let the system decide.
    return false;
  }
}

/**
 * Open a link, in Anbo when that is possible and wanted.
 *
 * Settings is its own window and owns no tabs, so from there the request is
 * handed to the main window instead. If that hand-off fails the link still
 * opens, just outside the app: a link that goes nowhere would be worse than
 * one that goes to the wrong browser.
 */
export async function openLink(url: string): Promise<void> {
  if (!shouldOpenInAnbo(url, preferInApp)) {
    await openUrl(url);
    return;
  }
  if (inAppOpener) {
    inAppOpener(url);
    return;
  }
  try {
    await emitTo(MAIN_WINDOW, OPEN_LINK_EVENT, url);
  } catch (error) {
    console.warn("could not hand the link to the main window", error);
    await openUrl(url);
  }
}

/** Main window only: take links other windows could not open themselves. */
export function listenForForwardedLinks(
  open: InAppOpener,
): Promise<() => void> {
  return listen<string>(OPEN_LINK_EVENT, ({ payload }) => {
    if (typeof payload === "string" && shouldOpenInAnbo(payload, true)) {
      open(payload);
    }
  });
}
