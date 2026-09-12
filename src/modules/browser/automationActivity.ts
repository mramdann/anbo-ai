import { listen } from "@tauri-apps/api/event";
import { useEffect, useSyncExternalStore } from "react";
import {
  type AutomationState,
  acceptsAutomationState,
  parseAutomationState,
} from "./automationState";

export const BROWSER_AUTOMATION_ACTIVITY_TTL_MS = 8_000;

type BrowserAutomationActivityPayload = {
  method?: unknown;
  params?: { tabId?: unknown } | null;
};

export type AutomationActor = AutomationState["actor"];

type ActivityTracker = {
  activities: Map<number, string>;
  details: Map<number, AutomationState>;
  // Identity is stored apart from the activity because it is known earlier and
  // outlives any single one. browser_open cannot be tracked -- the tab has no id
  // yet -- so the first thing the strip hears about a driven tab is the open
  // request, and without somewhere to keep the caller it fell back to the
  // generic robot until a tracked call arrived.
  actors: Map<number, AutomationActor>;
  // The tab each agent is currently driving, keyed by brand. An agent can hold
  // several tabs at once, but it only ever works one of them at a time, so only
  // that one carries the indicator -- and the indicator moves when the agent
  // moves. Keyed by arrival rather than by comparing sequences, because the open
  // marking has no sequence of its own to compare.
  focus: Map<string, number>;
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
  actors: new Map<number, AutomationActor>(),
  focus: new Map<string, number>(),
  listeners: new Set<() => void>(),
  timers: new Map<number, ReturnType<typeof setTimeout>>(),
  bound: false,
};
activityGlobal.__anboBrowserAutomationActivity = tracker;
tracker.details ??= new Map<number, AutomationState>();
tracker.actors ??= new Map<number, AutomationActor>();
tracker.focus ??= new Map<string, number>();

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

function releaseFocus(tabId: number): void {
  for (const [brand, focused] of tracker.focus) {
    if (focused === tabId) tracker.focus.delete(brand);
  }
}

function notifyActivityListeners(): void {
  for (const listener of tracker.listeners) listener();
}

export function markBrowserAutomationActivity(
  tabId: number,
  method: string,
  // Optional on purpose. A request that names nobody must leave the tab's
  // identity alone rather than assert a generic one: an invented "Remote agent"
  // outranks nothing, but it does outrank the truth on a tab whose real
  // controller is already known, and it is what the strip then shows.
  actor: AutomationActor | undefined,
  ttlMs: number | null = BROWSER_AUTOMATION_ACTIVITY_TTL_MS,
): void {
  if (!Number.isInteger(tabId) || !method) return;
  tracker.activities.set(tabId, method);
  const identity = actor ?? tracker.actors.get(tabId);
  if (identity) {
    tracker.actors.set(tabId, identity);
    tracker.focus.set(identity.brand, tabId);
  }
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
        tracker.actors.delete(tabId);
        releaseFocus(tabId);
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
  tracker.actors.delete(tabId);
  releaseFocus(tabId);
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

export function isBrowserAutomationFocused(tabId: number): boolean {
  const actor = tracker.actors.get(tabId);
  if (!actor) return false;
  const focused = tracker.focus.get(actor.brand);
  return focused === undefined || focused === tabId;
}

export function getBrowserAutomationActor(
  tabId: number,
): AutomationActor | null {
  return tracker.actors.get(tabId) ?? null;
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
      tracker.actors.delete(detail.tabId);
      releaseFocus(detail.tabId);
      notifyActivityListeners();
      return;
    }
    markBrowserAutomationActivity(
      detail.tabId,
      detail.method,
      detail.actor,
      detail.controlId
        ? null
        : ["done", "error", "idle"].includes(detail.phase)
          ? 1800
          : 120_000,
    );
    return;
  }
  const activity = browserAutomationActivityFromPayload(payload);
  if (activity) {
    tracker.details.delete(activity.tabId);
    markBrowserAutomationActivity(activity.tabId, activity.method, undefined);
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

export function useBrowserAutomationActor(
  tabId: number,
): AutomationActor | null {
  useEffect(ensureBrowserAutomationActivityListener, []);
  return useSyncExternalStore(
    (listener) => {
      tracker.listeners.add(listener);
      return () => {
        tracker.listeners.delete(listener);
      };
    },
    () => getBrowserAutomationActor(tabId),
    () => null,
  );
}

export function useBrowserAutomationFocused(tabId: number): boolean {
  useEffect(ensureBrowserAutomationActivityListener, []);
  return useSyncExternalStore(
    (listener) => {
      tracker.listeners.add(listener);
      return () => {
        tracker.listeners.delete(listener);
      };
    },
    () => isBrowserAutomationFocused(tabId),
    () => false,
  );
}
