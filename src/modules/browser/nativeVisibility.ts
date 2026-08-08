import { type RefObject, useSyncExternalStore } from "react";

const OVERLAY_SELECTOR =
  '[data-radix-popper-content-wrapper], [role="dialog"], [role="alertdialog"], [role="menu"], .fixed';

function isTooltip(element: Element): boolean {
  return (
    element.matches('[data-slot="tooltip-content"], [role="tooltip"]') ||
    element.querySelector('[data-slot="tooltip-content"], [role="tooltip"]') !==
      null
  );
}

type Rect = Pick<DOMRect, "bottom" | "height" | "left" | "right" | "top" | "width">;

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
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") continue;
    const bounds = element.getBoundingClientRect();
    if (!target ? bounds.width > 0 && bounds.height > 0 : rectsIntersect(bounds, target)) {
      return true;
    }
  }
  return false;
}

let overlayObserver: MutationObserver | null = null;
let overlayRaf = 0;
let overlaySubscribers = 0;
const overlayListeners = new Set<() => void>();

function recomputeOverlay() {
  overlayRaf = 0;
  overlayListeners.forEach((listener) => {
    listener();
  });
}

function scheduleOverlayCheck() {
  if (!overlayRaf) overlayRaf = requestAnimationFrame(recomputeOverlay);
}

function subscribeOverlay(listener: () => void): () => void {
  overlayListeners.add(listener);
  if (overlaySubscribers++ === 0) {
    overlayObserver = new MutationObserver(scheduleOverlayCheck);
    overlayObserver.observe(document.body, { childList: true, subtree: true });
    scheduleOverlayCheck();
  }
  return () => {
    overlayListeners.delete(listener);
    overlaySubscribers -= 1;
    if (overlaySubscribers === 0) {
      overlayObserver?.disconnect();
      overlayObserver = null;
      if (overlayRaf) cancelAnimationFrame(overlayRaf);
      overlayRaf = 0;
    }
  };
}

export function useNativeBrowserOverlayOpen(
  targetRef: RefObject<HTMLElement | null>,
): boolean {
  return useSyncExternalStore(
    subscribeOverlay,
    () => {
      const target = targetRef.current?.getBoundingClientRect();
      return target ? hasNativeBrowserOverlay(target) : false;
    },
    () => false,
  );
}

let dragActive = false;
const dragListeners = new Set<() => void>();

export function setNativeBrowserDragActive(active: boolean): void {
  if (active === dragActive) return;
  dragActive = active;
  dragListeners.forEach((listener) => {
    listener();
  });
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
