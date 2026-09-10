import { useEffect, useSyncExternalStore } from "react";

export type AutomationState = {
  tabId: number;
  requestId: number;
  sequence: number;
  controlId?: number;
  method: string;
  phase:
    | "queued"
    | "running"
    | "move"
    | "click"
    | "frame"
    | "done"
    | "error"
    | "ended";
  actor: { brand: string; label: string };
};

const BRANDS: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  antigravity: "Antigravity",
  opencode: "OpenCode",
  kimi: "Kimi",
  pi: "Pi",
  grok: "Grok",
  anbo: "Anbo",
  remote: "Remote agent",
};
const BRAND_IDS = new Set(Object.keys(BRANDS));
const PHASES = new Set([
  "queued",
  "running",
  "move",
  "click",
  "frame",
  "done",
  "error",
  "ended",
]);

export function parseAutomationState(payload: unknown): AutomationState | null {
  if (!payload || typeof payload !== "object") return null;
  const data = payload as Partial<AutomationState>;
  if (
    !Number.isSafeInteger(data.tabId) ||
    Number(data.tabId) <= 0 ||
    !Number.isSafeInteger(data.requestId) ||
    !Number.isSafeInteger(data.sequence) ||
    typeof data.method !== "string" ||
    !data.method ||
    data.method.length > 48 ||
    Number(data.requestId) <= 0 ||
    Number(data.sequence) <= 0 ||
    !PHASES.has(String(data.phase))
  )
    return null;
  const brand =
    typeof data.actor?.brand === "string" && BRAND_IDS.has(data.actor.brand)
      ? data.actor.brand
      : "remote";
  return {
    ...(Number.isSafeInteger(data.controlId) && Number(data.controlId) > 0
      ? { controlId: data.controlId }
      : {}),
    tabId: data.tabId as number,
    requestId: data.requestId as number,
    sequence: data.sequence as number,
    method: data.method,
    phase: data.phase as AutomationState["phase"],
    actor: { brand, label: BRANDS[brand] },
  };
}

export function acceptsAutomationState(
  previous: AutomationState | null,
  next: AutomationState,
): boolean {
  if (!previous) return true;
  if (next.sequence <= previous.sequence || next.requestId < previous.requestId)
    return false;
  if (
    previous.phase === "ended" &&
    previous.controlId &&
    previous.controlId === next.controlId
  )
    return false;
  if (next.phase === "ended") return next.controlId === previous.controlId;
  if (
    next.phase === "queued" &&
    !["queued", "done", "error", "ended"].includes(previous.phase)
  )
    return false;
  return !(
    ["done", "error"].includes(next.phase) &&
    next.requestId !== previous.requestId
  );
}

const ACTIONS: Record<string, string> = {
  // A claimed tab has done nothing yet, so "Action complete" would be a lie.
  start_session: "Holding this tab",
  click: "Clicking",
  double_click: "Double-clicking",
  type: "Typing",
  press: "Pressing a key",
  key: "Pressing a key",
  hover: "Hovering",
  drag: "Dragging",
  scroll: "Scrolling",
  scroll_to: "Scrolling",
  navigate: "Navigating",
  reload: "Reloading",
  find: "Finding a target",
  snapshot: "Reading",
  get_text: "Reading",
  wait: "Waiting for the page",
  screenshot: "Capturing",
  check: "Changing selection",
  select_option: "Selecting",
  focus: "Focusing",
  upload: "Attaching files",
};
export function automationLabel(state: AutomationState): string {
  if (state.phase === "queued") return "Waiting to act";
  if (state.phase === "ended") return "Remote session ended";
  if (state.method === "start_session") return "Holding this tab";
  if (state.phase === "done") return "Action complete";
  if (state.phase === "error") return "Action stopped";
  return ACTIONS[state.method] ?? "Working";
}

const EFFECTS_KEY = "anbo-browser-automation-effects";
const listeners = new Set<() => void>();
function readEnabled(): boolean {
  try {
    return localStorage.getItem(EFFECTS_KEY) !== "off";
  } catch {
    return true;
  }
}
let enabled = readEnabled();
function refresh() {
  enabled = readEnabled();
  for (const listener of listeners) listener();
}
export function setAutomationEffectsEnabled(value: boolean): void {
  enabled = value;
  try {
    localStorage.setItem(EFFECTS_KEY, value ? "on" : "off");
  } catch {
    /* Session-only fallback. */
  }
  for (const listener of listeners) listener();
}
export function useAutomationEffectsEnabled(): boolean {
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (event.key === EFFECTS_KEY) refresh();
    };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, []);
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => enabled,
    () => true,
  );
}
