import { useSyncExternalStore } from "react";

const OVERLAY_SELECTOR =
  '[data-radix-popper-content-wrapper], [role="dialog"], [role="alertdialog"], [role="menu"], .fixed';

function isTooltip(element: Element): boolean {
  return (
    element.querySelector('[data-slot="tooltip-content"], [role="tooltip"]') !==
    null
  );
}

export function hasNativePreviewOverlay(): boolean {
  for (const element of document.querySelectorAll(OVERLAY_SELECTOR)) {
    if (!isTooltip(element)) return true;
  }
  return false;
}

let overlayOpen = false;
let overlayObserver: MutationObserver | null = null;
let overlayRaf = 0;
let overlaySubscribers = 0;
const overlayListeners = new Set<() => void>();

function recomputeOverlay() {
  overlayRaf = 0;
  const next = hasNativePreviewOverlay();
  if (next === overlayOpen) return;
  overlayOpen = next;
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
    overlayObserver.observe(document.body, { childList: true });
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

export function useNativePreviewOverlayOpen(): boolean {
  return useSyncExternalStore(
    subscribeOverlay,
    () => overlayOpen,
    () => false,
  );
}

let dragActive = false;
const dragListeners = new Set<() => void>();

export function setNativePreviewDragActive(active: boolean): void {
  if (active === dragActive) return;
  dragActive = active;
  dragListeners.forEach((listener) => {
    listener();
  });
}

export function useNativePreviewDragActive(): boolean {
  return useSyncExternalStore(
    (listener) => {
      dragListeners.add(listener);
      return () => dragListeners.delete(listener);
    },
    () => dragActive,
    () => false,
  );
}
