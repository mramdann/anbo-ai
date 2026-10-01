import { subscribeWindowPresentation } from "@/lib/windowPresentation";
import { type RefObject, useCallback, useSyncExternalStore } from "react";
import type { PunchHole } from "./native";

const OVERLAY_SELECTOR =
  '[data-radix-popper-content-wrapper], [role="dialog"], [role="alertdialog"], [role="menu"], .fixed';

// Surfaces that float over a native page and stay visible and usable there:
// the page is cut around each of them instead of sinking behind Anbo. Sonner
// keeps a leaving toast in the DOM for its exit and hides the ones past
// visibleToasts, so only toasts on screen count. A toast's close button can
// sit partly outside the toast, so it gets a cut of its own.
const ON_SCREEN_TOAST =
  '[data-sonner-toast][data-visible="true"]:not([data-removed="true"])';
export const FLOATING_SURFACE_SELECTOR = [
  '[data-ai-mini-window][data-state="open"]',
  "[data-anbo-voice-overlay]",
  ON_SCREEN_TOAST,
  `${ON_SCREEN_TOAST} [data-close-button]`,
].join(", ");

/** The most floating surfaces a native page is cut around at once, which is
 * also what the backend accepts. Four toasts with their close buttons, the
 * mini window and the voice orb's parts fit with room to spare. */
export const MAX_FLOATING_SURFACES = 16;

function isTooltip(element: Element): boolean {
  return (
    element.matches('[data-slot="tooltip-content"], [role="tooltip"]') ||
    element.querySelector('[data-slot="tooltip-content"], [role="tooltip"]') !==
      null
  );
}

// The AI mini window is a persistent, user-positioned panel, and an agent
// toast stands for thirty seconds; neither is a transient overlay. They
// coexist with the browser via holes punched in the webview (see
// browserEmbedSetPunchHole), so they must NOT be treated as overlays that
// sink the whole webview to the bottom of the z-order.
function isPersistentFloatingSurface(element: Element): boolean {
  return (
    element.closest(
      "[data-ai-mini-window], [data-anbo-voice-overlay], [data-sonner-toaster]",
    ) !== null
  );
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

/**
 * A corner radius as drawn, in CSS pixels, from its computed value. A
 * percentage resolves against the box (as a circle, the shorter side's share),
 * and a pill's huge radius stops at half the shorter side. `scale` is how much
 * larger the box is drawn than laid out.
 */
export function cornerRadius(
  value: string,
  width: number,
  height: number,
  scale = 1,
): number {
  const amount = Number.parseFloat(value);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  const radius = value.trim().endsWith("%")
    ? (amount / 100) * Math.min(width, height)
    : amount * scale;
  return Math.min(radius, width / 2, height / 2);
}

/**
 * The hole a floating surface needs in a native page at `pane`, in physical
 * pixels from the pane's corner, or null when it misses the pane. The whole
 * surface is sent even where it reaches past the pane, so its rounded corners
 * are cut where they are drawn. Edges round inward: through a cut pixel the
 * surface only partly paints, the desktop behind Anbo's transparent window
 * would show, so such a pixel stays page.
 */
export function surfaceHole(
  pane: Rect,
  surface: Rect,
  radius: number,
  dpr: number,
): PunchHole | null {
  if (!rectsIntersect(surface, pane)) return null;
  // Layout values carry float noise; a hair past a pixel edge is that edge.
  const start = (value: number) => Math.ceil(value * dpr - 0.01);
  const end = (value: number) => Math.floor(value * dpr + 0.01);
  const x = start(surface.left - pane.left);
  const y = start(surface.top - pane.top);
  const width = end(surface.right - pane.left) - x;
  const height = end(surface.bottom - pane.top) - y;
  if (width <= 0 || height <= 0) return null;
  return {
    x,
    y,
    width,
    height,
    radius: Math.min(
      Math.round(radius * dpr),
      Math.floor(Math.min(width, height) / 2),
    ),
  };
}

// While the stack drops, a leaving toast keeps its cut until a dropping toast
// takes its place: closed early, the page would cover it a frame before the
// page sinks and Anbo draws it again.
const LEAVING_TOAST =
  '[data-sonner-toast][data-visible="true"][data-removed="true"]';
const DROPPING_SURFACE_SELECTOR = [
  FLOATING_SURFACE_SELECTOR,
  LEAVING_TOAST,
  `${LEAVING_TOAST} [data-close-button]`,
].join(", ");

/** Holes for every floating surface over a native page at `pane`. */
export function floatingSurfaceHoles(pane: Rect, dpr: number): PunchHole[] {
  const holes: PunchHole[] = [];
  for (const surface of document.querySelectorAll<HTMLElement>(
    stackDropping ? DROPPING_SURFACE_SELECTOR : FLOATING_SURFACE_SELECTOR,
  )) {
    if (holes.length >= MAX_FLOATING_SURFACES) break;
    const bounds = surface.getBoundingClientRect();
    if (!rectsIntersect(bounds, pane)) continue;
    const scale =
      surface.offsetWidth > 0 ? bounds.width / surface.offsetWidth : 1;
    const style = window.getComputedStyle(surface);
    // The roundest corner decides: a squarer cut would open a corner the
    // surface does not paint.
    const radius = Math.max(
      ...[
        style.borderTopLeftRadius,
        style.borderTopRightRadius,
        style.borderBottomRightRadius,
        style.borderBottomLeftRadius,
      ].map((value) => cornerRadius(value, bounds.width, bounds.height, scale)),
    );
    const hole = surfaceHole(pane, bounds, radius, dpr);
    if (hole) holes.push(hole);
  }
  return holes;
}

export function hasNativeBrowserOverlay(target?: Rect): boolean {
  for (const element of document.querySelectorAll(OVERLAY_SELECTOR)) {
    if (isTooltip(element)) continue;
    if (isPersistentFloatingSurface(element)) continue;
    // Measure before asking for computed style. An element with no area, or one
    // that misses the pane entirely, can never be an overlay, and skipping it
    // here avoids a style recalculation per match. `.fixed` is a Tailwind
    // utility, so this loop walks a large slice of a document that only grows:
    // tabs stay mounted for the life of the session.
    const bounds = element.getBoundingClientRect();
    const covers = !target
      ? bounds.width > 0 && bounds.height > 0
      : rectsIntersect(bounds, target);
    if (!covers) continue;
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") continue;
    return true;
  }
  return false;
}

// A cut reaches the screen a frame or two after the toast it follows, so when
// the stack drops into the gap a leaving toast makes, the slot it vacates can
// show the desktop through a cut that is still open. Around such a change an
// embedded page sinks below Anbo instead, as it does under a menu: Anbo then
// draws every toast above it pixel for pixel, and a sunk page carries no cuts
// (embed.rs). That is while the pointer is over the toasts, where every
// dismissal by hand starts, and for a moment after the stack last dropped or
// the pointer left. A drop nobody's pointer caused, a toast expiring or one
// dismissed by code, waits TOAST_DROP_HOLD_MS (globals.css) for the page to
// sink first.
/** Matches the delay the dropping toasts wait in globals.css. */
export const TOAST_DROP_HOLD_MS = 100;
const TOAST_SETTLE_MS = 150;
let pointerOverToasts = false;
let toastsSettling = false;
let stackDropping = false;
let toastsSettleAt = 0;
let toastSettleTimer: ReturnType<typeof setTimeout> | null = null;
const settlingToasts = new WeakSet<Element>();

type StackedToast = { index: number; removed: boolean; visible: boolean };

/**
 * Whether the toast at `index` leaving drops the stack: Sonner numbers toasts
 * from the newest, and every older one still on screen moves into the gap.
 */
export function toastRemovalDropsStack(
  index: number,
  stack: StackedToast[],
): boolean {
  return stack.some(
    (toast) => !toast.removed && toast.visible && toast.index > index,
  );
}

function stackOf(toast: HTMLElement): StackedToast[] {
  const toaster = toast.closest("[data-sonner-toaster]");
  if (!toaster) return [];
  return [...toaster.querySelectorAll<HTMLElement>("[data-sonner-toast]")].map(
    (element) => ({
      index: Number(element.dataset.index),
      removed: element.dataset.removed === "true",
      visible: element.dataset.visible === "true",
    }),
  );
}

/** Keeps the page below for `ms` more, never cutting a longer hold short. */
function settleToasts(ms: number): void {
  toastsSettling = true;
  const at = performance.now() + ms;
  if (toastSettleTimer && at <= toastsSettleAt) return;
  toastsSettleAt = at;
  if (toastSettleTimer) clearTimeout(toastSettleTimer);
  toastSettleTimer = setTimeout(() => {
    toastSettleTimer = null;
    toastsSettling = false;
    stackDropping = false;
    notifyNativeBrowserLayout();
  }, ms);
}

function setPointerOverToasts(over: boolean): void {
  if (over === pointerOverToasts) return;
  pointerOverToasts = over;
  if (over) emitLayoutChangeNow();
  else settleToasts(TOAST_SETTLE_MS);
}

function onPointerOver(event: PointerEvent): void {
  const target = event.target;
  setPointerOverToasts(
    target instanceof Element &&
      target.closest("[data-sonner-toaster]") !== null,
  );
}

function onPointerOut(event: PointerEvent): void {
  // Out of the document: onto a native page or out of the window.
  if (!event.relatedTarget) setPointerOverToasts(false);
}

/**
 * Follows the toaster's own changes. A toast leaving from under older ones
 * holds the page below Anbo while the stack drops. A toast is marked settled
 * once its entrance has been drawn, so only later moves wait (globals.css).
 */
export function trackToasterChanges(records: MutationRecord[]): void {
  for (const record of records) {
    const toast = record.target;
    if (!(toast instanceof HTMLElement)) continue;
    if (
      record.attributeName === "data-removed" &&
      toast.dataset.removed === "true" &&
      toastRemovalDropsStack(Number(toast.dataset.index), stackOf(toast))
    ) {
      stackDropping = true;
      settleToasts(TOAST_DROP_HOLD_MS + TOAST_SETTLE_MS);
      emitLayoutChangeNow();
    }
    if (
      record.attributeName === "data-mounted" &&
      toast.dataset.mounted === "true" &&
      !settlingToasts.has(toast)
    ) {
      settlingToasts.add(toast);
      // The first frame draws the entrance; marking in the second keeps it
      // from waiting.
      requestAnimationFrame(() =>
        requestAnimationFrame(() =>
          toast.setAttribute("data-anbo-settled", ""),
        ),
      );
    }
  }
  notifyNativeBrowserLayout();
}

/** Whether the toasts hold a native page at `target` below Anbo now. */
function toastsHoldPageBelow(target: Rect): boolean {
  if (!pointerOverToasts && !toastsSettling) return false;
  for (const toast of document.querySelectorAll(ON_SCREEN_TOAST)) {
    if (rectsIntersect(toast.getBoundingClientRect(), target)) return true;
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

/** Runs the listeners now, for a change the page must follow at once. */
function emitLayoutChangeNow(): void {
  if (layoutRaf) cancelAnimationFrame(layoutRaf);
  emitLayoutChange();
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
  document.addEventListener("pointerover", onPointerOver, true);
  document.addEventListener("pointerout", onPointerOut, true);
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
  document.removeEventListener("pointerover", onPointerOver, true);
  document.removeEventListener("pointerout", onPointerOut, true);
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
  pointerOverToasts = false;
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

/**
 * Whether an embedded page at `targetRef` should sink below Anbo: under an
 * overlay, or while the toasts over it hold it there.
 */
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
    return target
      ? toastsHoldPageBelow(target) || hasNativeBrowserOverlay(target)
      : false;
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
