import { listen } from "@tauri-apps/api/event";
import { useEffect, useSyncExternalStore } from "react";
import {
  acceptsAutomationState,
  parseAutomationState,
  type AutomationState,
} from "./automationState";

export const BROWSER_AUTOMATION_ACTIVITY_TTL_MS = 8_000;

type BrowserAutomationActivityPayload = {
  method?: unknown;
  params?: { tabId?: unknown } | null;
};

type ActivityTracker = {
  activities: Map<number, string>;
  details: Map<number, AutomationState>;
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
  details: new Map<number, AutomationState>(),
  listeners: new Set<() => void>(),
  timers: new Map<number, ReturnType<typeof setTimeout>>(),
  bound: false,
};
activityGlobal.__anboBrowserAutomationActivity = tracker;
tracker.details ??= new Map<number, AutomationState>();

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
  ttlMs: number | null = BROWSER_AUTOMATION_ACTIVITY_TTL_MS,
): void {
  if (!Number.isInteger(tabId) || !method) return;
  tracker.activities.set(tabId, method);
  const previous = tracker.timers.get(tabId);
  if (previous) clearTimeout(previous);
  tracker.timers.delete(tabId);
  if (ttlMs !== null) {
    tracker.timers.set(
      tabId,
      setTimeout(() => {
        tracker.timers.delete(tabId);
        if (!tracker.activities.delete(tabId)) return;
        tracker.details.delete(tabId);
        notifyActivityListeners();
      }, ttlMs),
    );
  }
  notifyActivityListeners();
}

export function clearBrowserAutomationActivity(tabId: number): void {
  const timer = tracker.timers.get(tabId);
  if (timer) clearTimeout(timer);
  tracker.timers.delete(tabId);
  tracker.details.delete(tabId);
  if (tracker.activities.delete(tabId)) notifyActivityListeners();
}

export function getBrowserAutomationActivity(tabId: number): string | null {
  return tracker.activities.get(tabId) ?? null;
}

export function getBrowserAutomationState(
  tabId: number,
): AutomationState | null {
  return tracker.details.get(tabId) ?? null;
}

export function receiveBrowserAutomationActivity(payload: unknown): void {
  const detail = parseAutomationState(payload);
  if (detail) {
    if (
      !acceptsAutomationState(getBrowserAutomationState(detail.tabId), detail)
    )
      return;
    tracker.details.set(detail.tabId, detail);
    if (detail.phase === "ended") {
      const timer = tracker.timers.get(detail.tabId);
      if (timer) clearTimeout(timer);
      tracker.timers.delete(detail.tabId);
      tracker.activities.delete(detail.tabId);
      notifyActivityListeners();
      return;
    }
    markBrowserAutomationActivity(
      detail.tabId,
      detail.method,
      detail.controlId
        ? null
        : ["done", "error"].includes(detail.phase)
          ? 1800
          : 120_000,
    );
    return;
  }
  const activity = browserAutomationActivityFromPayload(payload);
  if (activity) {
    tracker.details.delete(activity.tabId);
    markBrowserAutomationActivity(activity.tabId, activity.method);
  }
}

export function ensureBrowserAutomationActivityListener(): void {
  if (tracker.bound || typeof window === "undefined") return;
  tracker.bound = true;
  void listen("browser-automation-activity", (event) => {
    receiveBrowserAutomationActivity(event.payload);
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

export function useBrowserAutomationState(
  tabId: number,
): AutomationState | null {
  useEffect(ensureBrowserAutomationActivityListener, []);
  return useSyncExternalStore(
    (listener) => {
      tracker.listeners.add(listener);
      return () => {
        tracker.listeners.delete(listener);
      };
    },
    () => getBrowserAutomationState(tabId),
    () => null,
  );
}
