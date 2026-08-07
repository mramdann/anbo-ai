import { invoke } from "@tauri-apps/api/core";

export const PREVIEW_NAV_EVENT = "anbo:preview-nav";

export type PreviewNavEvent = {
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

export type PreviewAction = "back" | "forward" | "reload" | "stop";

const PREVIEW_INSTANCE_ID = crypto.randomUUID();
let sessionReady: Promise<void> | null = null;

function ensurePreviewSession(): Promise<void> {
  if (sessionReady) return sessionReady;
  const ready = invoke<void>("preview_embed_begin_session", {
    instanceId: PREVIEW_INSTANCE_ID,
  }).catch((error) => {
    if (sessionReady === ready) sessionReady = null;
    throw error;
  });
  sessionReady = ready;
  return ready;
}

export function beginPreviewSession(): Promise<void> {
  return retry(ensurePreviewSession);
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

export function createPreviewOwnerId(): string {
  return crypto.randomUUID();
}

export function toPhysicalBounds(rect: DOMRect, dpr: number): EmbedBounds {
  return {
    x: Math.round(rect.left * dpr),
    y: Math.round(rect.top * dpr),
    width: Math.round(rect.width * dpr),
    height: Math.round(rect.height * dpr),
  };
}

export function isSupportedBrowserUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
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

export async function previewEmbedUpdate(
  tabId: number,
  ownerId: string,
  url: string,
  bounds: EmbedBounds,
  visible: boolean,
): Promise<void> {
  await ensurePreviewSession();
  await invoke("preview_embed_update", {
    tabId,
    instanceId: PREVIEW_INSTANCE_ID,
    ownerId,
    url,
    bounds,
    visible,
  });
}

export async function previewEmbedNavigate(
  tabId: number,
  ownerId: string,
  url: string,
): Promise<void> {
  await ensurePreviewSession();
  await invoke("preview_embed_navigate", {
    tabId,
    instanceId: PREVIEW_INSTANCE_ID,
    ownerId,
    url,
  });
}

export async function previewEmbedDispatch(
  tabId: number,
  ownerId: string,
  action: PreviewAction,
): Promise<void> {
  await ensurePreviewSession();
  await invoke("preview_embed_dispatch", {
    tabId,
    instanceId: PREVIEW_INSTANCE_ID,
    ownerId,
    action,
  });
}

export async function previewEmbedUrl(
  tabId: number,
  ownerId: string,
): Promise<string | null> {
  await ensurePreviewSession();
  return invoke<string | null>("preview_embed_url", {
    tabId,
    instanceId: PREVIEW_INSTANCE_ID,
    ownerId,
  });
}

export async function previewEmbedSnapshot(
  tabId: number,
  ownerId: string,
): Promise<string | null> {
  await ensurePreviewSession();
  return invoke<string | null>("preview_embed_snapshot", {
    tabId,
    instanceId: PREVIEW_INSTANCE_ID,
    ownerId,
  });
}

export async function previewEmbedSetUiOverlay(
  tabId: number,
  ownerId: string,
  active: boolean,
): Promise<void> {
  await ensurePreviewSession();
  await invoke("preview_embed_set_ui_overlay", {
    tabId,
    instanceId: PREVIEW_INSTANCE_ID,
    ownerId,
    active,
  });
}

export async function previewEmbedSuspend(
  tabId: number,
  ownerId: string,
): Promise<void> {
  await ensurePreviewSession();
  await invoke("preview_embed_suspend", {
    tabId,
    instanceId: PREVIEW_INSTANCE_ID,
    ownerId,
  });
}

export async function previewEmbedRelease(
  tabId: number,
  ownerId: string,
): Promise<void> {
  await ensurePreviewSession();
  await retry(() =>
    invoke<void>("preview_embed_release", {
      tabId,
      instanceId: PREVIEW_INSTANCE_ID,
      ownerId,
    }),
  );
}

export async function previewEmbedClose(tabId: number): Promise<void> {
  await ensurePreviewSession();
  await retry(() =>
    invoke<void>("preview_embed_close", {
      tabId,
      instanceId: PREVIEW_INSTANCE_ID,
    }),
  );
}
