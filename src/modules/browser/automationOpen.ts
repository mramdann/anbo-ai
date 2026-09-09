export const BROWSER_OPEN_REQUEST_EVENT = "anbo:browser-open-request";
export const BROWSER_OPEN_RESPONSE_EVENT = "anbo:browser-open-response";
export const BROWSER_CLOSE_REQUEST_EVENT = "anbo:browser-close-request";
export const BROWSER_CLOSE_RESPONSE_EVENT = "anbo:browser-close-response";
export const BROWSER_TABS_REQUEST_EVENT = "anbo:browser-tabs-request";
export const BROWSER_TABS_RESPONSE_EVENT = "anbo:browser-tabs-response";
export const BROWSER_POPUP_REQUEST_EVENT = "anbo:browser-popup-request";

export type BrowserOpenRequest = {
  requestId: string;
  url: string;
  workspace?: string | null;
};

export type BrowserCloseRequest = {
  requestId: string;
  tabId: number;
  workspace: string;
};

export type BrowserTabsRequest = {
  requestId: string;
};

export type BrowserPopupRequest = {
  sourceTabId: number;
  url: string;
};

export type BrowserPopupStamp = {
  key: string;
  at: number;
};

export function acceptBrowserPopupRequest(
  previous: BrowserPopupStamp | null,
  request: BrowserPopupRequest,
  now = Date.now(),
): { accept: boolean; stamp: BrowserPopupStamp } {
  const stamp = {
    key: `${request.sourceTabId}\u0000${request.url}`,
    at: now,
  };
  return {
    accept: !(previous?.key === stamp.key && now - previous.at < 1_000),
    stamp,
  };
}

export type BrowserTabMetadata = {
  tabId: number;
  title: string;
  url: string;
  spaceId: string;
  workspace: string | null;
  active: boolean;
  spaceActive: boolean;
  automationTarget: boolean;
  automationActive: boolean;
  automationMethod: string | null;
  loading: boolean;
  pendingUrl: string | null;
};

type RequestHandler<T> = (request: T) => void;
type RequestSubscribe<T> = (handler: RequestHandler<T>) => Promise<() => void>;

function createRequestListener<T>(subscribe: RequestSubscribe<T>) {
  let handler: RequestHandler<T> | null = null;
  let subscription: Promise<void> | null = null;
  let unlisten: (() => void) | null = null;
  let generation = 0;

  const start = () => {
    if (subscription || unlisten) return;
    const currentGeneration = generation;
    subscription = subscribe((request) => handler?.(request))
      .then((dispose) => {
        if (generation !== currentGeneration) {
          dispose();
          return;
        }
        subscription = null;
        unlisten = dispose;
      })
      .catch(() => {
        if (generation === currentGeneration) subscription = null;
      });
  };

  return {
    setHandler(next: RequestHandler<T>) {
      handler = next;
      start();
    },
    stop() {
      generation += 1;
      handler = null;
      unlisten?.();
      unlisten = null;
      subscription = null;
    },
  };
}

export const createBrowserOpenListener = createRequestListener<BrowserOpenRequest>;
export const createBrowserCloseListener = createRequestListener<BrowserCloseRequest>;
export const createBrowserTabsListener = createRequestListener<BrowserTabsRequest>;
export const createBrowserPopupListener = createRequestListener<BrowserPopupRequest>;

export {
  type AutomationTabPlacement as BrowserOpenPlacement,
  automationTabPlacement as browserOpenPlacement,
} from "@/modules/tabs/lib/automationTabPlacement";

type BrowserOpenSpace = {
  id: string;
  root: string | null;
  env: { kind: "local" | "wsl" };
};

type BrowserOpenSpaceResult =
  | { ok: true; space: BrowserOpenSpace }
  | { ok: false; error: string };

function normalizedRoot(space: BrowserOpenSpace): string | null {
  if (!space.root) return null;
  const normalized = space.root.replace(/\\/g, "/").replace(/\/+$/, "");
  return space.env.kind === "local" ? normalized.toLowerCase() : normalized;
}

export function resolveBrowserOpenSpace(
  spaces: BrowserOpenSpace[],
  workspace?: string | null,
): BrowserOpenSpaceResult {
  const requested = workspace?.trim();
  if (!requested) {
    return {
      ok: false,
      error:
        "browser_open requires a workspace root or space id; the active UI workspace is never used as a fallback",
    };
  }

  const byId = spaces.find((space) => space.id === requested);
  if (byId) return { ok: true, space: byId };

  const requestedRoot = requested.replace(/\\/g, "/").replace(/\/+$/, "");
  const matches = spaces.filter((space) => {
    const root = normalizedRoot(space);
    if (root === null) return false;
    return space.env.kind === "local"
      ? root === requestedRoot.toLowerCase()
      : root === requestedRoot;
  });
  if (matches.length === 1) return { ok: true, space: matches[0] };
  if (matches.length > 1) {
    return {
      ok: false,
      error: "workspace matches multiple Anbo spaces; pass a space id",
    };
  }
  return {
    ok: false,
    error: `workspace is not open in Anbo: ${requested}`,
  };
}

type BrowserCloseTarget = {
  id: number;
  kind: string;
  spaceId: string;
};

type BrowserCloseTargetResult =
  | { ok: true; space: BrowserOpenSpace; tab: BrowserCloseTarget }
  | { ok: false; error: string };

export function resolveBrowserCloseTarget(
  tabs: BrowserCloseTarget[],
  spaces: BrowserOpenSpace[],
  tabId: number,
  workspace?: string | null,
): BrowserCloseTargetResult {
  const resolved = resolveBrowserOpenSpace(spaces, workspace);
  if (!resolved.ok) return resolved;
  const tab = tabs.find(
    (candidate) =>
      candidate.id === tabId &&
      candidate.kind === "browser" &&
      candidate.spaceId === resolved.space.id,
  );
  if (!tab) {
    return {
      ok: false,
      error: `browser tab ${tabId} is not open in workspace: ${workspace?.trim() ?? ""}`,
    };
  }
  return { ok: true, space: resolved.space, tab };
}

export function resolveBrowserPopupSpace(
  tabs: BrowserCloseTarget[],
  spaces: BrowserOpenSpace[],
  sourceTabId: number,
): BrowserOpenSpaceResult {
  const source = tabs.find(
    (tab) => tab.id === sourceTabId && tab.kind === "browser",
  );
  if (!source) {
    return { ok: false, error: `popup source tab ${sourceTabId} is not open` };
  }
  const space = spaces.find((candidate) => candidate.id === source.spaceId);
  if (!space) {
    return {
      ok: false,
      error: `popup source workspace ${source.spaceId} is not open`,
    };
  }
  return { ok: true, space };
}
