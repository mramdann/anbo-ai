import { subscribeWindowPresentation } from "@/lib/windowPresentation";
import { type RefObject, useCallback, useSyncExternalStore } from "react";

const OVERLAY_SELECTOR =
  '[data-radix-popper-content-wrapper], [role="dialog"], [role="alertdialog"], [role="menu"], .fixed';

function isTooltip(element: Element): boolean {
  return (
    element.matches('[data-slot="tooltip-content"], [role="tooltip"]') ||
    element.querySelector('[data-slot="tooltip-content"], [role="tooltip"]') !==
      null
  );
}

// The AI mini window is a persistent, user-positioned panel — not a transient
// overlay. It coexists with the browser via a punched-out hole in the webview
// (see browserEmbedSetPunchHole), so it must NOT be treated as an overlay that
// sinks the whole webview to the bottom of the z-order.
function isAiMiniWindow(element: Element): boolean {
  return element.closest("[data-ai-mini-window]") !== null;
}

type Rect = Pick<
  DOMRect,
  "bottom" | "height" | "left" | "right" | "top" | "width"
>;

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return (
    a.width > 0 &&
    a.height > 0 &&
    b.width > 0 &&
    b.height > 0 &&
    a.left < b.right &&
    a.right > b.left &&
    a.top < b.bottom &&
    a.bottom > b.top
  );
}

export function hasNativeBrowserOverlay(target?: Rect): boolean {
  for (const element of document.querySelectorAll(OVERLAY_SELECTOR)) {
    if (isTooltip(element)) continue;
    if (isAiMiniWindow(element)) continue;
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") continue;
    const bounds = element.getBoundingClientRect();
    if (
      !target
        ? bounds.width > 0 && bounds.height > 0
        : rectsIntersect(bounds, target)
    ) {
      return true;
    }
  }
  return false;
}

const LAYOUT_FALLBACK_MS = 1_500;
const layoutListeners = new Set<() => void>();
let layoutRaf = 0;
let layoutFallback: ReturnType<typeof setInterval> | null = null;
let presentationDispose: (() => void) | null = null;
let pointerTracking = false;

function emitLayoutChange(): void {
  layoutRaf = 0;
  layoutListeners.forEach((listener) => {
    listener();
  });
}

export function notifyNativeBrowserLayout(): void {
  if (layoutRaf || typeof requestAnimationFrame === "undefined") return;
  layoutRaf = requestAnimationFrame(emitLayoutChange);
}

function stopPointerTracking(): void {
  if (!pointerTracking) return;
  pointerTracking = false;
  document.removeEventListener("pointermove", notifyNativeBrowserLayout, true);
}

function onPointerDown(): void {
  notifyNativeBrowserLayout();
  if (pointerTracking) return;
  pointerTracking = true;
  document.addEventListener("pointermove", notifyNativeBrowserLayout, true);
}

function onPointerEnd(): void {
  stopPointerTracking();
  notifyNativeBrowserLayout();
}

function startLayoutEvents(): void {
  presentationDispose = subscribeWindowPresentation(() => {
    // A minimized window may stop animation frames immediately, so browser
    // children must consume the suspended state synchronously.
    emitLayoutChange();
  });
  window.addEventListener("resize", notifyNativeBrowserLayout);
  window.addEventListener("scroll", notifyNativeBrowserLayout, true);
  window.visualViewport?.addEventListener("resize", notifyNativeBrowserLayout);
  window.visualViewport?.addEventListener("scroll", notifyNativeBrowserLayout);
  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("pointerup", onPointerEnd, true);
  document.addEventListener("pointercancel", onPointerEnd, true);
  document.addEventListener("click", notifyNativeBrowserLayout, true);
  document.addEventListener("keydown", notifyNativeBrowserLayout, true);
  document.addEventListener("focusin", notifyNativeBrowserLayout, true);
  document.addEventListener("visibilitychange", notifyNativeBrowserLayout);
  document.addEventListener("transitionrun", notifyNativeBrowserLayout, true);
  document.addEventListener("transitionend", notifyNativeBrowserLayout, true);
  document.addEventListener("animationstart", notifyNativeBrowserLayout, true);
  document.addEventListener("animationend", notifyNativeBrowserLayout, true);
  layoutFallback = setInterval(notifyNativeBrowserLayout, LAYOUT_FALLBACK_MS);
  notifyNativeBrowserLayout();
}

function stopLayoutEvents(): void {
  presentationDispose?.();
  presentationDispose = null;
  window.removeEventListener("resize", notifyNativeBrowserLayout);
  window.removeEventListener("scroll", notifyNativeBrowserLayout, true);
  window.visualViewport?.removeEventListener(
    "resize",
    notifyNativeBrowserLayout,
  );
  window.visualViewport?.removeEventListener(
    "scroll",
    notifyNativeBrowserLayout,
  );
  document.removeEventListener("pointerdown", onPointerDown, true);
  document.removeEventListener("pointerup", onPointerEnd, true);
  document.removeEventListener("pointercancel", onPointerEnd, true);
  document.removeEventListener("click", notifyNativeBrowserLayout, true);
  document.removeEventListener("keydown", notifyNativeBrowserLayout, true);
  document.removeEventListener("focusin", notifyNativeBrowserLayout, true);
  document.removeEventListener("visibilitychange", notifyNativeBrowserLayout);
  document.removeEventListener(
    "transitionrun",
    notifyNativeBrowserLayout,
    true,
  );
  document.removeEventListener(
    "transitionend",
    notifyNativeBrowserLayout,
    true,
  );
  document.removeEventListener(
    "animationstart",
    notifyNativeBrowserLayout,
    true,
  );
  document.removeEventListener("animationend", notifyNativeBrowserLayout, true);
  stopPointerTracking();
  if (layoutFallback) clearInterval(layoutFallback);
  layoutFallback = null;
  if (layoutRaf) cancelAnimationFrame(layoutRaf);
  layoutRaf = 0;
}

export function subscribeNativeBrowserLayout(listener: () => void): () => void {
  layoutListeners.add(listener);
  if (layoutListeners.size === 1) startLayoutEvents();
  return () => {
    layoutListeners.delete(listener);
    if (layoutListeners.size === 0) stopLayoutEvents();
  };
}

export function useNativeBrowserOverlayOpen(
  targetRef: RefObject<HTMLElement | null>,
  enabled = true,
): boolean {
  const subscribe = useCallback(
    (listener: () => void) =>
      enabled ? subscribeNativeBrowserLayout(listener) : () => {},
    [enabled],
  );
  const getSnapshot = useCallback(() => {
    if (!enabled) return false;
    const target = targetRef.current?.getBoundingClientRect();
    return target ? hasNativeBrowserOverlay(target) : false;
  }, [enabled, targetRef]);
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

let dragActive = false;
const dragListeners = new Set<() => void>();

export function setNativeBrowserDragActive(active: boolean): void {
  if (active === dragActive) return;
  dragActive = active;
  dragListeners.forEach((listener) => {
    listener();
  });
  notifyNativeBrowserLayout();
}

export function useNativeBrowserDragActive(): boolean {
  return useSyncExternalStore(
    (listener) => {
      dragListeners.add(listener);
      return () => dragListeners.delete(listener);
    },
    () => dragActive,
    () => false,
  );
}
