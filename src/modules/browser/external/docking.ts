import {
  isWindowPresentationCovered,
  isWindowPresentationDocumentVisible,
} from "@/lib/windowPresentation";
import { toPhysicalBounds } from "@/modules/browser/native";
import {
  hasNativeBrowserOverlay,
  notifyNativeBrowserLayout,
  subscribeNativeBrowserLayout,
  useNativeBrowserDragActive,
} from "@/modules/browser/nativeVisibility";
import type { BrowserTab } from "@/modules/tabs";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";

type Bounds = { x: number; y: number; width: number; height: number };
export type DockLayout = Bounds & {
  visible: boolean;
  covered: boolean;
  cutouts: Bounds[];
};
type OrderedLayout = DockLayout & { revision: number };
let lastRevision = 0;
export function orderedLayout(layout: DockLayout): OrderedLayout {
  lastRevision = Math.max(lastRevision + 1, Date.now() * 1000);
  return { ...layout, revision: lastRevision };
}
export type DockStatus = {
  dockId: string | null;
  live: boolean;
  reason: string | null;
};

export function createDockLayoutOwnership() {
  const owners = new Map<string, symbol>();
  return {
    claim(dockId: string) {
      const token = Symbol(dockId);
      owners.set(dockId, token);
      return {
        current: () => owners.get(dockId) === token,
        release: () => {
          if (owners.get(dockId) !== token) return false;
          owners.delete(dockId);
          return true;
        },
      };
    },
  };
}

const layoutOwnership = createDockLayoutOwnership();
// Anbo surfaces that float over the page and must stay interactive there.
const floatingSurfaces =
  '[data-ai-mini-window][data-state="open"], [data-anbo-voice-overlay]';
const overlays = `[role="dialog"], [role="alertdialog"], [role="menu"], [role="tooltip"], [data-radix-popper-content-wrapper], .fixed, ${floatingSurfaces}`;
const MAX_CUTOUTS = 8;

export function dockMutationAffectsLayout(
  records: MutationRecord[],
  surface: HTMLElement,
): boolean {
  const relevant = (node: Node) => {
    if (node.nodeType !== 1) return false;
    const element = node as Element;
    return (
      element.contains(surface) ||
      element.matches(overlays) ||
      element.hasAttribute("data-ai-mini-window") ||
      element.closest(overlays) !== null ||
      element.querySelector(overlays) !== null
    );
  };
  const checked = new Set<Node>();
  return records.some((record) => {
    if (!checked.has(record.target)) {
      checked.add(record.target);
      if (relevant(record.target)) return true;
    }
    if (record.type === "attributes")
      return [
        "role",
        "data-ai-mini-window",
        "data-anbo-voice-overlay",
      ].includes(record.attributeName ?? "");
    return [...record.addedNodes, ...record.removedNodes].some(relevant);
  });
}

export function createDockLayoutPublisher(
  ownership: ReturnType<ReturnType<typeof createDockLayoutOwnership>["claim"]>,
  write: (layout: OrderedLayout) => Promise<DockStatus>,
  settled: (status: DockStatus) => void,
  failed: (cause: unknown) => void,
) {
  let flight: Promise<void> | undefined;
  let desired: OrderedLayout | null = null;
  let last = "";
  let stopped = false;
  const flush = (): Promise<void> => {
    flight ??= (async () => {
      while (desired) {
        if (!stopped && !ownership.current()) {
          desired = null;
          return;
        }
        const next = desired;
        desired = null;
        const key = JSON.stringify({ ...next, revision: 0 });
        if (last === key) continue;
        try {
          const status = await write(next);
          last = key;
          if (!stopped && ownership.current()) settled(status);
        } catch (cause) {
          last = "";
          if (!stopped && ownership.current()) failed(cause);
        }
      }
    })().finally(() => {
      flight = undefined;
      if (desired) return flush();
    });
    return flight;
  };
  return {
    publish(layout: DockLayout) {
      if (stopped || !ownership.current()) return Promise.resolve();
      desired = orderedLayout(layout);
      return flush();
    },
    stop(layout: DockLayout) {
      if (stopped) return flight ?? Promise.resolve();
      stopped = true;
      desired = ownership.release()
        ? orderedLayout({ ...layout, visible: false })
        : null;
      return flush();
    },
  };
}

const hiddenLayout: DockLayout = {
  x: 0,
  y: 0,
  width: 0,
  height: 0,
  visible: false,
  covered: false,
  cutouts: [],
};

/** The panel and any floating Anbo surfaces over it, in physical pixels of
 * Anbo's client area. The backend decides whether the page can be shown. */
export function panelLayout(
  rect: Bounds,
  ratio: number,
  visible: boolean,
  covered = false,
  floating: Bounds[] = [],
): DockLayout {
  const { x: left, y: top } = rect;
  const values = [left, top, rect.width, rect.height, ratio];
  if (
    values.some((value) => !Number.isFinite(value)) ||
    ratio <= 0 ||
    ratio > 8
  )
    return hiddenLayout;
  const bounds = toPhysicalBounds(
    { left, top, width: rect.width, height: rect.height },
    ratio,
  );
  if (
    [bounds.x, bounds.y, bounds.width, bounds.height].some(
      (value) => value < 0 || value > 16384,
    )
  )
    return hiddenLayout;
  const cutouts: Bounds[] = [];
  for (const surface of floating) {
    const x = Math.max(left, surface.x);
    const y = Math.max(top, surface.y);
    const right = Math.min(left + rect.width, surface.x + surface.width);
    const bottom = Math.min(top + rect.height, surface.y + surface.height);
    if (right <= x || bottom <= y || cutouts.length >= MAX_CUTOUTS) continue;
    const cutout = toPhysicalBounds(
      { left: x, top: y, width: right - x, height: bottom - y },
      ratio,
    );
    if (cutout.width > 0 && cutout.height > 0) cutouts.push(cutout);
  }
  return {
    ...bounds,
    visible: visible && bounds.width > 0 && bounds.height > 0,
    covered,
    cutouts,
  };
}

// While a docked page shows through the panel, Anbo's own backgrounds around
// it turn transparent the same way they do for the embedded browser.
const liveOwners = new Set<symbol>();
function syncLiveSurface(): void {
  if (liveOwners.size > 0)
    document.documentElement.dataset.nativeDockLive = "true";
  else delete document.documentElement.dataset.nativeDockLive;
}

export function useBrowserDock(tab: BrowserTab, visible: boolean) {
  const surface = useRef<HTMLDivElement>(null);
  const [dockId, setDockId] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [reason, setReason] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A dockview drag needs its drop targets over the page, like any overlay.
  const dragging = useNativeBrowserDragActive();
  const draggingRef = useRef(dragging);
  const external = tab.external;
  const identity = `${tab.id}:${external?.connectionId}:${external?.selectionId}`;
  const latest = useRef(identity);
  const requestEpoch = useRef(0);
  latest.current = identity;

  const call = useCallback(
    (action: string, id: string | null, layout?: OrderedLayout) =>
      invoke<DockStatus>("browser_external_dock", {
        request: {
          action,
          tabId: tab.id,
          connectionId: external?.connectionId,
          selectionId: external?.selectionId,
          dockId: id,
          layout,
        },
      }),
    [tab.id, external?.connectionId, external?.selectionId],
  );

  const apply = useCallback((status: DockStatus) => {
    setDockId(status.dockId);
    setLive(status.dockId !== null && status.live);
    setReason(status.dockId !== null ? status.reason : null);
  }, []);

  const measure = useCallback(() => {
    const rect = surface.current?.getBoundingClientRect();
    if (!rect) return hiddenLayout;
    const floating = [
      ...document.querySelectorAll<HTMLElement>(floatingSurfaces),
    ].map((element) => {
      const bounds = element.getBoundingClientRect();
      return {
        x: bounds.left,
        y: bounds.top,
        width: bounds.width,
        height: bounds.height,
      };
    });
    // While Anbo minimizes or restores it paints a cover over everything; the
    // page must not show through it.
    const presented =
      isWindowPresentationDocumentVisible(
        document.visibilityState === "visible",
      ) && !isWindowPresentationCovered();
    return panelLayout(
      rect,
      window.devicePixelRatio || 1,
      visible && presented,
      draggingRef.current || hasNativeBrowserOverlay(rect),
      floating,
    );
  }, [visible]);

  useEffect(() => {
    draggingRef.current = dragging;
    notifyNativeBrowserLayout();
  }, [dragging]);

  useEffect(() => {
    let cancelled = false;
    const epoch = ++requestEpoch.current;
    apply({ dockId: null, live: false, reason: null });
    setBusy(false);
    setError(null);
    if (external?.connected)
      void call("status", null)
        .then((status) => {
          if (!cancelled && requestEpoch.current === epoch) apply(status);
        })
        .catch((cause) => {
          if (!cancelled && requestEpoch.current === epoch)
            setError(String(cause));
        });
    return () => {
      cancelled = true;
      requestEpoch.current += 1;
    };
  }, [call, apply, external?.connected]);

  useEffect(() => {
    if (!dockId) return;
    let cancelled = false;
    const listeners = [
      listen<{ tabId: number; dockId: string }>(
        "anbo:browser-dock-released",
        ({ payload }) => {
          if (
            !cancelled &&
            payload.tabId === tab.id &&
            payload.dockId === dockId
          )
            apply({ dockId: null, live: false, reason: null });
        },
      ),
      listen<{
        tabId: number;
        dockId: string;
        live: boolean;
        reason: string | null;
      }>("anbo:browser-dock-state", ({ payload }) => {
        if (
          !cancelled &&
          payload.tabId === tab.id &&
          payload.dockId === dockId
        ) {
          setLive(payload.live);
          setReason(payload.reason);
        }
      }),
    ];
    // A state change can land before these listeners exist.
    void call("status", null)
      .then((status) => {
        if (!cancelled && status.dockId === dockId) apply(status);
      })
      .catch(() => {});
    for (const listener of listeners)
      void listener.then(
        (unlisten) => {
          if (cancelled) unlisten();
        },
        (cause) => {
          if (!cancelled) setError(String(cause));
        },
      );
    return () => {
      cancelled = true;
      for (const listener of listeners)
        void listener.then(
          (unlisten) => unlisten(),
          () => {},
        );
    };
  }, [dockId, tab.id, call, apply]);

  const presenting = Boolean(dockId) && live && visible;
  useEffect(() => {
    if (!presenting) return;
    const owner = Symbol(tab.id);
    liveOwners.add(owner);
    syncLiveSurface();
    return () => {
      liveOwners.delete(owner);
      syncLiveSurface();
    };
  }, [presenting, tab.id]);

  useEffect(() => {
    if (!dockId || !external?.connected || !visible) return;
    const ownership = layoutOwnership.claim(dockId);
    let stopped = false;
    let frame = 0;
    const publisher = createDockLayoutPublisher(
      ownership,
      (layout) => call("layout", dockId, layout),
      (status) => {
        setError(null);
        if (!status.dockId) apply(status);
      },
      (cause) => setError(String(cause)),
    );
    const update = () => {
      frame = 0;
      if (!ownership.current()) return;
      void publisher.publish(measure());
    };
    const schedule = () => {
      if (!stopped && ownership.current() && !frame)
        frame = requestAnimationFrame(update);
    };
    const observer = new ResizeObserver(schedule);
    if (surface.current) observer.observe(surface.current);
    const mutations = new MutationObserver((records) => {
      if (
        surface.current &&
        dockMutationAffectsLayout(records, surface.current)
      )
        schedule();
    });
    mutations.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        "style",
        "class",
        "data-state",
        "role",
        "data-ai-mini-window",
        "data-anbo-voice-overlay",
      ],
    });
    const unsubscribe = subscribeNativeBrowserLayout(schedule);
    update();
    return () => {
      stopped = true;
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
      mutations.disconnect();
      unsubscribe();
      void publisher.stop(measure());
    };
  }, [dockId, external?.connected, measure, call, apply, visible]);

  const toggle = async () => {
    setBusy(true);
    setError(null);
    const started = identity;
    const epoch = ++requestEpoch.current;
    try {
      const result = await call(
        dockId ? "release" : "attach",
        dockId,
        orderedLayout(measure()),
      );
      if (latest.current === started && requestEpoch.current === epoch)
        apply(result);
    } catch (cause) {
      if (latest.current === started && requestEpoch.current === epoch)
        setError(String(cause));
    } finally {
      if (latest.current === started && requestEpoch.current === epoch)
        setBusy(false);
    }
  };

  return { surface, dockId, live: presenting, reason, busy, error, toggle };
}
