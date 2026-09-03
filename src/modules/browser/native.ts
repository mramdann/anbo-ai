import { invoke } from "@tauri-apps/api/core";
import type { WorkspaceEnv } from "@/modules/workspace";

export const BROWSER_NAV_EVENT = "anbo:browser-nav";
export const BROWSER_LOADING_FALLBACK_MS = 30_000;

export type BrowserNavEvent = {
  tabId: number;
  ownerId: string;
  kind: "navigated" | "loaded" | "title";
  url: string;
  title?: string;
};

export type EmbedBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type BrowserAction = "back" | "forward" | "reload" | "stop";

export type BrowserWorkspaceContext = {
  root: string | null;
  workspace: WorkspaceEnv;
};

export type BrowserDataUsage = {
  bytes: number;
  files: number;
  complete: boolean;
};

const BROWSER_INSTANCE_ID = crypto.randomUUID();
const browserOwnerIds = new Map<number, string>();
let sessionReady: Promise<void> | null = null;

function ensureBrowserSession(): Promise<void> {
  if (sessionReady) return sessionReady;
  const ready = invoke<void>("browser_embed_begin_session", {
    instanceId: BROWSER_INSTANCE_ID,
  }).catch((error) => {
    if (sessionReady === ready) sessionReady = null;
    throw error;
  });
  sessionReady = ready;
  return ready;
}

export function beginBrowserSession(): Promise<void> {
  return retry(ensureBrowserSession);
}

async function retry(operation: () => Promise<void>): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await operation();
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }
  throw lastError;
}

export function createBrowserOwnerId(tabId: number): string {
  const existing = browserOwnerIds.get(tabId);
  if (existing) return existing;
  const ownerId = crypto.randomUUID();
  browserOwnerIds.set(tabId, ownerId);
  return ownerId;
}

export function forgetBrowserOwnerId(tabId: number, ownerId: string): void {
  if (browserOwnerIds.get(tabId) === ownerId) browserOwnerIds.delete(tabId);
}

export function toPhysicalBounds(
  rect:
    | DOMRect
    | {
        left: number;
        top: number;
        width: number;
        height: number;
        right?: number;
        bottom?: number;
      },
  dpr: number,
): EmbedBounds {
  const x = Math.round(rect.left * dpr);
  const y = Math.round(rect.top * dpr);
  const right = Math.round((rect.right ?? rect.left + rect.width) * dpr);
  const bottom = Math.round((rect.bottom ?? rect.top + rect.height) * dpr);
  return {
    x,
    y,
    width: Math.max(0, right - x),
    height: Math.max(0, bottom - y),
  };
}

export function canMeasureBrowserPane(
  documentVisible: boolean,
  allowedUrl: boolean,
  hasElement: boolean,
): boolean {
  return documentVisible && allowedUrl && hasElement;
}

export function shouldShowBrowserPane(
  canMeasure: boolean,
  paneVisible: boolean,
  hasArea: boolean,
  suppressed: boolean,
): boolean {
  return canMeasure && paneVisible && hasArea && !suppressed;
}

export function browserPresentationBounds(
  visible: boolean,
  measured: EmbedBounds,
  lastVisible: EmbedBounds | null,
): EmbedBounds {
  return visible || !lastVisible ? measured : lastVisible;
}

export function isSupportedBrowserUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" ||
      url.protocol === "https:" ||
      url.protocol === "file:"
    );
  } catch {
    return false;
  }
}

export function isSelfReferenceUrl(
  value: string,
  appUrl = window.location.href,
): boolean {
  try {
    const target = new URL(value);
    const app = new URL(appUrl);
    return target.origin === app.origin;
  } catch {
    return false;
  }
}

export function browserUrlError(
  value: string,
  appUrl = window.location.href,
): string | null {
  if (!value) return null;
  if (!isSupportedBrowserUrl(value)) {
    return "Only HTTP(S) URLs and files from the active workspace can load in the browser.";
  }
  if (isSelfReferenceUrl(value, appUrl)) {
    return "Anbo cannot be opened inside its own browser pane.";
  }
  return null;
}

export function isReportableBrowserNavUrl(
  value: string,
  appUrl = window.location.href,
): boolean {
  return (
    value.length > 0 &&
    isSupportedBrowserUrl(value) &&
    !isSelfReferenceUrl(value, appUrl)
  );
}

export async function browserEmbedUpdate(
  tabId: number,
  ownerId: string,
  url: string,
  bounds: EmbedBounds,
  visible: boolean,
  context: BrowserWorkspaceContext,
): Promise<void> {
  await ensureBrowserSession();
  await invoke("browser_embed_update", {
    tabId,
    instanceId: BROWSER_INSTANCE_ID,
    ownerId,
    url,
    workspaceRoot: context.root,
    workspace: context.workspace,
    bounds,
    visible,
  });
}

export async function browserEmbedNavigate(
  tabId: number,
  ownerId: string,
  url: string,
  context: BrowserWorkspaceContext,
): Promise<void> {
  await ensureBrowserSession();
  await invoke("browser_embed_navigate", {
    tabId,
    instanceId: BROWSER_INSTANCE_ID,
    ownerId,
    url,
    workspaceRoot: context.root,
    workspace: context.workspace,
  });
}

export function browserDataUsage(): Promise<BrowserDataUsage> {
  return invoke<BrowserDataUsage>("browser_data_usage");
}

export function browserClearData(): Promise<void> {
  return invoke<void>("browser_clear_data");
}

export async function browserEmbedDispatch(
  tabId: number,
  ownerId: string,
  action: BrowserAction,
): Promise<void> {
  await ensureBrowserSession();
  await invoke("browser_embed_dispatch", {
    tabId,
    instanceId: BROWSER_INSTANCE_ID,
    ownerId,
    action,
  });
}

export async function browserEmbedUrl(
  tabId: number,
  ownerId: string,
): Promise<string | null> {
  await ensureBrowserSession();
  return invoke<string | null>("browser_embed_url", {
    tabId,
    instanceId: BROWSER_INSTANCE_ID,
    ownerId,
  });
}

export async function browserEmbedInsertText(
  tabId: number,
  ownerId: string,
  text: string,
): Promise<boolean> {
  await ensureBrowserSession();
  return invoke<boolean>("browser_embed_insert_text", {
    tabId,
    instanceId: BROWSER_INSTANCE_ID,
    ownerId,
    text,
  });
}

export async function browserEmbedSnapshot(
  tabId: number,
  ownerId: string,
): Promise<string | null> {
  await ensureBrowserSession();
  return invoke<string | null>("browser_embed_snapshot", {
    tabId,
    instanceId: BROWSER_INSTANCE_ID,
    ownerId,
  });
}

export async function browserEmbedSetUiOverlay(
  tabId: number,
  ownerId: string,
  active: boolean,
): Promise<void> {
  await ensureBrowserSession();
  await invoke("browser_embed_set_ui_overlay", {
    tabId,
    instanceId: BROWSER_INSTANCE_ID,
    ownerId,
    active,
  });
}

export async function browserEmbedSetZoom(
  id: number,
  ownerId: string,
  zoom: number,
): Promise<void> {
  await ensureBrowserSession();
  await invoke("browser_embed_set_zoom", {
    tabId: id,
    instanceId: BROWSER_INSTANCE_ID,
    ownerId,
    zoom,
  });
}

/** A rectangular hole in physical pixels relative to the browser webview. */
export type PunchHole = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export async function browserEmbedSetPunchHole(
  tabId: number,
  ownerId: string,
  holes: PunchHole[],
): Promise<void> {
  await ensureBrowserSession();
  await invoke("browser_embed_set_punch_hole", {
    tabId,
    instanceId: BROWSER_INSTANCE_ID,
    ownerId,
    holes,
  });
}

export async function browserEmbedSuspend(
  tabId: number,
  ownerId: string,
): Promise<void> {
  await ensureBrowserSession();
  await invoke("browser_embed_suspend", {
    tabId,
    instanceId: BROWSER_INSTANCE_ID,
    ownerId,
  });
}

export async function browserEmbedSuspendAllPresentations(): Promise<void> {
  await ensureBrowserSession();
  await invoke("browser_embed_suspend_all_presentations");
}

export async function browserEmbedRelease(
  tabId: number,
  ownerId: string,
): Promise<void> {
  await ensureBrowserSession();
  await retry(() =>
    invoke<void>("browser_embed_release", {
      tabId,
      instanceId: BROWSER_INSTANCE_ID,
      ownerId,
    }),
  );
}

export async function browserEmbedClose(tabId: number): Promise<void> {
  await ensureBrowserSession();
  await retry(() =>
    invoke<void>("browser_embed_close", {
      tabId,
      instanceId: BROWSER_INSTANCE_ID,
    }),
  );
}
