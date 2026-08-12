import { listen } from "@tauri-apps/api/event";
import { useEffect, useSyncExternalStore } from "react";

export const BROWSER_AUTOMATION_ACTIVITY_TTL_MS = 8_000;

type BrowserAutomationActivityPayload = {
  method?: unknown;
  params?: { tabId?: unknown } | null;
};

type ActivityTracker = {
  activities: Map<number, string>;
  listeners: Set<() => void>;
  timers: Map<number, ReturnType<typeof setTimeout>>;
  bound: boolean;
};

type ActivityGlobal = typeof globalThis & {
  __anboBrowserAutomationActivity?: ActivityTracker;
};

const activityGlobal = globalThis as ActivityGlobal;
const tracker = activityGlobal.__anboBrowserAutomationActivity ?? {
  activities: new Map<number, string>(),
  listeners: new Set<() => void>(),
  timers: new Map<number, ReturnType<typeof setTimeout>>(),
  bound: false,
};
activityGlobal.__anboBrowserAutomationActivity = tracker;

export function browserAutomationActivityFromPayload(
  payload: unknown,
): { tabId: number; method: string } | null {
  if (!payload || typeof payload !== "object") return null;
  const candidate = payload as BrowserAutomationActivityPayload;
  const tabId = candidate.params?.tabId;
  const method = candidate.method;
  if (!Number.isInteger(tabId) || typeof method !== "string" || !method)
    return null;
  return { tabId: tabId as number, method };
}

function notifyActivityListeners(): void {
  for (const listener of tracker.listeners) listener();
}

export function markBrowserAutomationActivity(
  tabId: number,
  method: string,
  ttlMs = BROWSER_AUTOMATION_ACTIVITY_TTL_MS,
): void {
  if (!Number.isInteger(tabId) || !method) return;
  tracker.activities.set(tabId, method);
  const previous = tracker.timers.get(tabId);
  if (previous) clearTimeout(previous);
  tracker.timers.set(
    tabId,
    setTimeout(() => {
      tracker.timers.delete(tabId);
      if (!tracker.activities.delete(tabId)) return;
      notifyActivityListeners();
    }, ttlMs),
  );
  notifyActivityListeners();
}

export function clearBrowserAutomationActivity(tabId: number): void {
  const timer = tracker.timers.get(tabId);
  if (timer) clearTimeout(timer);
  tracker.timers.delete(tabId);
  if (tracker.activities.delete(tabId)) notifyActivityListeners();
}

export function getBrowserAutomationActivity(tabId: number): string | null {
  return tracker.activities.get(tabId) ?? null;
}

export function ensureBrowserAutomationActivityListener(): void {
  if (tracker.bound || typeof window === "undefined") return;
  tracker.bound = true;
  void listen("browser-automation-activity", (event) => {
    const activity = browserAutomationActivityFromPayload(event.payload);
    if (activity) {
      markBrowserAutomationActivity(activity.tabId, activity.method);
    }
  }).catch(() => {
    tracker.bound = false;
  });
}

export function useBrowserAutomationActivity(tabId: number): string | null {
  useEffect(ensureBrowserAutomationActivityListener, []);
  return useSyncExternalStore(
    (listener) => {
      tracker.listeners.add(listener);
      return () => {
        tracker.listeners.delete(listener);
      };
    },
    () => getBrowserAutomationActivity(tabId),
    () => null,
  );
}
