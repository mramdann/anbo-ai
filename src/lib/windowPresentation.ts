import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

export type WindowPresentationPhase = "ready" | "suspended" | "restoring";

const RESTORE_IDLE_MS = 180;
const STABLE_VIEWPORT_CAPTURE_MS = 220;
const STABLE_VIEWPORT_WIDTH = "--anbo-stable-viewport-width";
const STABLE_VIEWPORT_HEIGHT = "--anbo-stable-viewport-height";
const listeners = new Set<(phase: WindowPresentationPhase) => void>();

let phase: WindowPresentationPhase = "ready";
let coverVisible = false;
let initialized = false;
let restoreTimer: number | null = null;
let stableViewportTimer: number | null = null;
let revealFrame = 0;
let stateCheck = 0;
let stableViewportWidth = 0;
let stableViewportHeight = 0;

export function shouldSuspendWindowPresentation(
  documentHidden: boolean,
  minimized: boolean,
): boolean {
  return documentHidden || minimized;
}

export function isWindowPresentationBlocked(): boolean {
  return phase !== "ready";
}

export function isWindowPresentationCovered(): boolean {
  return coverVisible;
}

export function subscribeWindowPresentation(
  listener: (next: WindowPresentationPhase) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function isPlausibleStableViewport(
  width: number,
  height: number,
  previousWidth: number,
  previousHeight: number,
): boolean {
  if (width <= 0 || height <= 0) return false;
  if (previousWidth <= 0 || previousHeight <= 0) return true;
  return !(width < previousWidth * 0.75 && height < previousHeight * 0.75);
}

function captureStableViewport(): void {
  const width = Math.round(window.innerWidth);
  const height = Math.round(window.innerHeight);
  if (
    !isPlausibleStableViewport(
      width,
      height,
      stableViewportWidth,
      stableViewportHeight,
    )
  ) {
    return;
  }
  stableViewportWidth = width;
  stableViewportHeight = height;
  document.documentElement.style.setProperty(
    STABLE_VIEWPORT_WIDTH,
    `${width}px`,
  );
  document.documentElement.style.setProperty(
    STABLE_VIEWPORT_HEIGHT,
    `${height}px`,
  );
}

function scheduleStableViewportCapture(): void {
  if (phase !== "ready") return;
  if (stableViewportTimer !== null) {
    window.clearTimeout(stableViewportTimer);
  }
  stableViewportTimer = window.setTimeout(() => {
    stableViewportTimer = null;
    if (phase === "ready") captureStableViewport();
  }, STABLE_VIEWPORT_CAPTURE_MS);
}

function cancelRestore(): void {
  if (restoreTimer !== null) window.clearTimeout(restoreTimer);
  restoreTimer = null;
  if (revealFrame) cancelAnimationFrame(revealFrame);
  revealFrame = 0;
}

function notify(next: WindowPresentationPhase): void {
  for (const listener of listeners) {
    try {
      listener(next);
    } catch (error) {
      console.error("[anbo] window presentation listener failed:", error);
    }
  }
}

function publish(next: WindowPresentationPhase): void {
  if (phase === next) return;
  phase = next;
  if (next !== "ready") {
    coverVisible = true;
    document.documentElement.dataset.windowPresentation = next;
  }
  notify(next);
}

export function suspendWindowPresentation(): void {
  if (phase === "ready") captureStableViewport();
  if (stableViewportTimer !== null) {
    window.clearTimeout(stableViewportTimer);
    stableViewportTimer = null;
  }
  cancelRestore();
  publish("suspended");
}

function revealSettledWindow(): void {
  publish("ready");
  // Give Dockview, CodeMirror, xterm, and native browser subscribers two
  // complete frames to consume the final window geometry before revealing it.
  window.dispatchEvent(new Event("resize"));
  revealFrame = requestAnimationFrame(() => {
    revealFrame = requestAnimationFrame(() => {
      revealFrame = 0;
      coverVisible = false;
      delete document.documentElement.dataset.windowPresentation;
      captureStableViewport();
      // Native child webviews stay hidden until this final signal. They are
      // outside the React stacking context, so the CSS cover cannot mask them.
      notify("ready");
    });
  });
}

function scheduleRestore(): void {
  if (phase === "ready") return;
  publish("restoring");
  if (restoreTimer !== null) window.clearTimeout(restoreTimer);
  restoreTimer = window.setTimeout(() => {
    restoreTimer = null;
    revealSettledWindow();
  }, RESTORE_IDLE_MS);
}

async function syncNativeWindowState(): Promise<void> {
  const check = ++stateCheck;
  const minimized = await getCurrentWindow()
    .isMinimized()
    .catch(() => false);
  if (check !== stateCheck) return;
  if (shouldSuspendWindowPresentation(document.hidden, minimized)) {
    suspendWindowPresentation();
  } else {
    scheduleRestore();
  }
}

export function resumeWindowPresentation(): void {
  void syncNativeWindowState();
}

export function initializeWindowPresentation(): void {
  if (initialized || !isTauri()) return;
  initialized = true;
  captureStableViewport();
  const appWindow = getCurrentWindow();
  const onVisibilityChange = () => {
    if (document.hidden) suspendWindowPresentation();
    else void syncNativeWindowState();
  };
  document.addEventListener("visibilitychange", onVisibilityChange);
  const onViewportResize = () => {
    scheduleStableViewportCapture();
    resumeWindowPresentation();
  };
  window.addEventListener("resize", onViewportResize, { passive: true });
  void appWindow.onResized(() => void syncNativeWindowState());
  void appWindow.onFocusChanged(() => void syncNativeWindowState());
  void syncNativeWindowState();
}
