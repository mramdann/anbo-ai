import { listen } from "@tauri-apps/api/event";
import { useEffect, useSyncExternalStore } from "react";
import {
  BROWSER_DESIGN_EVENT,
  type BrowserDesignStatus,
  type BrowserDesignTool,
  browserDesignSet,
} from "@/modules/browser/native";

export const DESIGN_TOOLS: readonly BrowserDesignTool[] = [
  "pen",
  "box",
  "arrow",
  "pick",
  "hand",
];

export type BrowserDesignEvent = {
  kind: "state" | "exit";
  status: BrowserDesignStatus;
};

type DesignTracker = {
  statuses: Map<number, BrowserDesignStatus>;
  listeners: Set<() => void>;
  bound: boolean;
};

type DesignGlobal = typeof globalThis & {
  __anboBrowserDesign?: DesignTracker;
};

const designGlobal = globalThis as DesignGlobal;
const tracker: DesignTracker = designGlobal.__anboBrowserDesign ?? {
  statuses: new Map<number, BrowserDesignStatus>(),
  listeners: new Set<() => void>(),
  bound: false,
};
designGlobal.__anboBrowserDesign = tracker;

const IDLE: Omit<BrowserDesignStatus, "tabId"> = {
  active: false,
  tool: "box",
  marks: 0,
  dirty: false,
};
const idleByTab = new Map<number, BrowserDesignStatus>();

function idleStatus(tabId: number): BrowserDesignStatus {
  let status = idleByTab.get(tabId);
  if (!status) {
    status = { tabId, ...IDLE };
    idleByTab.set(tabId, status);
  }
  return status;
}

export function parseBrowserDesignStatus(
  payload: unknown,
): BrowserDesignStatus | null {
  if (!payload || typeof payload !== "object") return null;
  const data = payload as Partial<BrowserDesignStatus>;
  if (
    !Number.isSafeInteger(data.tabId) ||
    Number(data.tabId) <= 0 ||
    typeof data.active !== "boolean" ||
    !DESIGN_TOOLS.includes(data.tool as BrowserDesignTool) ||
    !Number.isSafeInteger(data.marks) ||
    Number(data.marks) < 0
  )
    return null;
  const limit =
    typeof data.limit === "string" && data.limit ? data.limit : undefined;
  return {
    tabId: data.tabId as number,
    active: data.active,
    tool: data.tool as BrowserDesignTool,
    marks: data.marks as number,
    dirty: data.dirty === true,
    ...(limit ? { limit } : {}),
  };
}

export function parseBrowserDesignEvent(
  payload: unknown,
): BrowserDesignEvent | null {
  const status = parseBrowserDesignStatus(payload);
  if (!status) return null;
  const kind = (payload as { kind?: unknown }).kind;
  return { kind: kind === "exit" ? "exit" : "state", status };
}

function notifyListeners(): void {
  for (const listener of tracker.listeners) listener();
}

const MAX_TRACKED_TABS = 64;

export function applyBrowserDesignStatus(status: BrowserDesignStatus): void {
  if (status.active) {
    tracker.statuses.delete(status.tabId);
    tracker.statuses.set(status.tabId, status);
    while (tracker.statuses.size > MAX_TRACKED_TABS) {
      const oldest = tracker.statuses.keys().next().value;
      if (oldest === undefined) break;
      tracker.statuses.delete(oldest);
    }
  } else {
    tracker.statuses.delete(status.tabId);
  }
  notifyListeners();
}

export function forgetBrowserDesign(tabId: number): void {
  idleByTab.delete(tabId);
  if (tracker.statuses.delete(tabId)) notifyListeners();
}

export function getBrowserDesignStatus(tabId: number): BrowserDesignStatus {
  return tracker.statuses.get(tabId) ?? idleStatus(tabId);
}

export function receiveBrowserDesignEvent(payload: unknown): void {
  const event = parseBrowserDesignEvent(payload);
  if (!event) return;
  applyBrowserDesignStatus(event.status);
  // Escape inside the page cannot reach this window's shortcuts, so the layer
  // asks to be closed and the answer is the same call the toolbar makes.
  if (event.kind === "exit" && event.status.active) {
    void browserDesignSet(event.status.tabId, false)
      .then(applyBrowserDesignStatus)
      .catch(() => {});
  }
}

export function ensureBrowserDesignListener(): void {
  if (tracker.bound || typeof window === "undefined") return;
  tracker.bound = true;
  void listen(BROWSER_DESIGN_EVENT, (event) => {
    receiveBrowserDesignEvent(event.payload);
  }).catch(() => {
    tracker.bound = false;
  });
}

export function useBrowserDesign(tabId: number): BrowserDesignStatus {
  useEffect(ensureBrowserDesignListener, []);
  return useSyncExternalStore(
    (listener) => {
      tracker.listeners.add(listener);
      return () => {
        tracker.listeners.delete(listener);
      };
    },
    () => getBrowserDesignStatus(tabId),
    () => idleStatus(tabId),
  );
}
