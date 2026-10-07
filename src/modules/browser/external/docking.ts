import {
  isWindowPresentationCovered,
  isWindowPresentationDocumentVisible,
  subscribeWindowPresentation,
} from "@/lib/windowPresentation";
import { toPhysicalBounds } from "@/modules/browser/native";
import {
  FLOATING_SURFACE_SELECTOR,
  hasNativeBrowserOverlay,
  MAX_FLOATING_SURFACES,
  notifyNativeBrowserLayout,
  subscribeNativeBrowserLayout,
  useNativeBrowserDragActive,
} from "@/modules/browser/nativeVisibility";
import type { BrowserTab } from "@/modules/tabs";
import { subscribeBrowserTabShown } from "@/modules/tabs/lib/browserTabShow";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

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
// Anbo menus, and the surfaces that float over the page and must stay
// interactive there: the same ones the embedded browser is cut around, toasts
// among them. A cutout stays rectangular: the docked browser's region is not
// cut there, so around a rounded surface Anbo's transparent pixels show the
// page below.
const overlays = `[role="dialog"], [role="alertdialog"], [role="menu"], [role="tooltip"], [data-radix-popper-content-wrapper], .fixed, ${FLOATING_SURFACE_SELECTOR}`;

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
    if (right <= x || bottom <= y || cutouts.length >= MAX_FLOATING_SURFACES)
      continue;
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

// Only one page can be docked at a time. The tab that shows next takes the
// dock over, and the previous page goes back to its own browser window.
export type DockHolder = {
  tabId: number;
  shown: boolean;
  connectionId?: string;
  dockId: string;
  release: () => Promise<void>;
};

/** The mounted panes whose tab holds the dock. A tab hidden in its panel also
 * has a pane in the background host, so it can have two, and it holds the dock
 * until the last one goes. */
export function createDockHolders() {
  const entries = new Set<DockHolder>();
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const notify of listeners) notify();
  };
  return {
    add(entry: DockHolder): () => void {
      entries.add(entry);
      changed();
      return () => {
        if (entries.delete(entry)) changed();
      };
    },
    /** Whether a shown pane of another tab holds the page. */
    heldElsewhere(tabId: number): boolean {
      for (const entry of entries)
        if (entry.tabId !== tabId && entry.shown) return true;
      return false;
    },
    /** One pane of each other tab holding the dock, to give it up through. */
    others(tabId: number): DockHolder[] {
      const byTab = new Map<number, DockHolder>();
      for (const entry of entries)
        if (entry.tabId !== tabId && !byTab.has(entry.tabId))
          byTab.set(entry.tabId, entry);
      return [...byTab.values()];
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
const holders = createDockHolders();

/** The holder whose dock window a tab of the same browser profile takes over:
 * its page gives way in that window, so no new window opens and the panel
 * never goes blank. */
export function handoverFrom(
  others: DockHolder[],
  connectionId: string | undefined,
): DockHolder | null {
  const [only, ...rest] = others;
  return connectionId &&
    only &&
    rest.length === 0 &&
    only.connectionId === connectionId
    ? only
    : null;
}

// The shown panes by tab, with their browser connection, and the takeovers
// under way. A page leaving its panel while another tab of its browser comes
// into view stays there until that tab has taken the dock window over.
const shownPanes = new Map<number, string>();
const handovers = new Set<{ connectionId: string; done: Promise<void> }>();
const HANDOVER_START_MS = 400;
const HANDOVER_LIMIT_MS = 1500;

/** Resolves when a page leaving its panel may hide: at once without another
 * shown tab of its browser, else once that tab has taken the dock window over
 * or has not begun to within a moment. */
async function handedOver(
  tabId: number,
  connectionId: string | undefined,
): Promise<void> {
  if (!connectionId) return;
  const taker = [...shownPanes].some(
    ([id, connection]) => id !== tabId && connection === connectionId,
  );
  if (!taker) return;
  const sleep = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));
  const deadline = Date.now() + HANDOVER_START_MS;
  for (;;) {
    const pending = [...handovers].filter(
      (handover) => handover.connectionId === connectionId,
    );
    if (pending.length > 0) {
      await Promise.race([
        Promise.allSettled(pending.map((handover) => handover.done)),
        sleep(HANDOVER_LIMIT_MS),
      ]);
      return;
    }
    if (Date.now() >= deadline) return;
    await sleep(16);
  }
}
let dockQueue: Promise<unknown> = Promise.resolve();
function exclusiveDock<T>(run: () => Promise<T>): Promise<T> {
  const next = dockQueue.catch(() => {}).then(run);
  dockQueue = next;
  return next;
}

export type AutoDockState = {
  visible: boolean;
  connected: boolean;
  focused: boolean;
  presented: boolean;
  checked: boolean;
  docked: boolean;
  busy: boolean;
  held: boolean;
  /** A shown panel of another tab holds the page. */
  elsewhere: boolean;
};

/** A shown, connected tab takes the dock by itself, but only while Anbo is in
 * front: a browser window opened for a dock behind another app would flash
 * over that app. A hold (a failure, or the page moved back to the browser)
 * lasts until the tab is shown again or someone clicks. From another shown
 * panel only a click or an agent's input takes the page, so it does not jump
 * between panels side by side when one appears or the workspace shows again. */
export function shouldAttachDock(state: AutoDockState): boolean {
  return (
    state.visible &&
    state.connected &&
    state.focused &&
    state.presented &&
    state.checked &&
    !state.docked &&
    !state.busy &&
    !state.held &&
    !state.elsewhere
  );
}

// Whether Anbo's window is the foreground window, shared by every external
// tab. The page's own focus is not enough (the window can be in front while
// the page is not focused), and a window event alone can be missed, so any
// focus change asks the window again.
let anboFocused = typeof document === "undefined" ? true : document.hasFocus();
const focusListeners = new Set<() => void>();
let watchingFocus = false;
function setAnboFocused(next: boolean) {
  if (next === anboFocused) return;
  anboFocused = next;
  for (const notify of focusListeners) notify();
}
function syncAnboFocus() {
  if (document.hasFocus()) setAnboFocused(true);
  else
    void getCurrentWindow()
      .isFocused()
      .then(setAnboFocused, () => {});
}
function subscribeAnboFocus(listener: () => void) {
  focusListeners.add(listener);
  if (!watchingFocus) {
    watchingFocus = true;
    window.addEventListener("focus", syncAnboFocus);
    window.addEventListener("blur", syncAnboFocus);
    void getCurrentWindow()
      .onFocusChanged(({ payload }) => {
        if (payload) setAnboFocused(true);
        else syncAnboFocus();
      })
      .catch(() => {});
  }
  syncAnboFocus();
  return () => {
    focusListeners.delete(listener);
  };
}

function presentedNow(): boolean {
  return (
    isWindowPresentationDocumentVisible(
      document.visibilityState === "visible",
    ) && !isWindowPresentationCovered()
  );
}
function subscribePresented(listener: () => void) {
  const unsubscribe = subscribeWindowPresentation(() => listener());
  document.addEventListener("visibilitychange", listener);
  return () => {
    unsubscribe();
    document.removeEventListener("visibilitychange", listener);
  };
}

export type DockHold = "failed" | "moved";

export function useBrowserDock(tab: BrowserTab, visible: boolean) {
  const surface = useRef<HTMLDivElement>(null);
  const [dockId, setDockId] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [reason, setReason] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The first status answer tells whether this tab already holds the dock.
  const [checked, setChecked] = useState(false);
  const [hold, setHold] = useState<DockHold | null>(null);
  // A click on the panel asks for the page: Anbo is in front by definition.
  const [asked, setAsked] = useState(false);
  const askedRef = useRef(asked);
  askedRef.current = asked;
  const focused = useSyncExternalStore(
    subscribeAnboFocus,
    () => anboFocused,
    () => true,
  );
  const presented = useSyncExternalStore(
    subscribePresented,
    presentedNow,
    () => true,
  );
  const elsewhere = useSyncExternalStore(
    holders.subscribe,
    () => holders.heldElsewhere(tab.id),
    () => false,
  );
  // A dockview drag needs its drop targets over the page, like any overlay.
  const dragging = useNativeBrowserDragActive();
  const draggingRef = useRef(dragging);
  const external = tab.external;
  const connectionId = external?.connectionId;
  const identity = `${tab.id}:${external?.connectionId}:${external?.selectionId}`;
  const latest = useRef(identity);
  const requestEpoch = useRef(0);
  const mounted = useRef(true);
  latest.current = identity;
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  const call = useCallback(
    (
      action: string,
      id: string | null,
      layout?: OrderedLayout,
      takeover?: string,
    ) =>
      invoke<DockStatus>("browser_external_dock", {
        request: {
          action,
          tabId: tab.id,
          connectionId: external?.connectionId,
          selectionId: external?.selectionId,
          dockId: id,
          layout,
          takeover,
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
      ...document.querySelectorAll<HTMLElement>(FLOATING_SURFACE_SELECTOR),
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
    setHold(null);
    setChecked(false);
    if (external?.connected)
      void call("status", null)
        .then((status) => {
          if (cancelled || requestEpoch.current !== epoch) return;
          apply(status);
          setChecked(true);
        })
        .catch((cause) => {
          if (cancelled || requestEpoch.current !== epoch) return;
          setError(String(cause));
          setHold("failed");
          setChecked(true);
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
          ) {
            apply({ dockId: null, live: false, reason: null });
            // The page left the dock in the browser; taking it straight back
            // would fight whoever moved it.
            setHold("moved");
          }
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

  // The tab holding the dock gives it up when another tab needs it.
  useEffect(() => {
    if (!dockId) return;
    return holders.add({
      tabId: tab.id,
      shown: visible,
      connectionId,
      dockId,
      release: async () => {
        await call("release", dockId);
        if (mounted.current && latest.current === identity)
          apply({ dockId: null, live: false, reason: null });
      },
    });
  }, [dockId, tab.id, call, apply, identity, visible, connectionId]);

  // A page of the same browser leaving its panel as this one comes into view
  // waits for this tab to take the dock window over.
  useEffect(() => {
    if (!visible || !external?.connected || !connectionId) return;
    shownPanes.set(tab.id, connectionId);
    return () => {
      if (shownPanes.get(tab.id) === connectionId) shownPanes.delete(tab.id);
    };
  }, [visible, external?.connected, connectionId, tab.id]);

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
      const layout = measure();
      // Another tab of this browser coming into view takes the dock window
      // over, and this page stays in it until that tab's page replaces it.
      queueMicrotask(() => {
        void handedOver(tab.id, connectionId).then(() =>
          publisher.stop(layout),
        );
      });
    };
  }, [
    dockId,
    external?.connected,
    measure,
    call,
    apply,
    visible,
    tab.id,
    connectionId,
  ]);

  // Showing the tab again is the natural retry.
  const shown = useRef(visible);
  useEffect(() => {
    if (visible && !shown.current) setHold(null);
    shown.current = visible;
  }, [visible]);

  const attach = useCallback(async () => {
    const requested = askedRef.current;
    const started = latest.current;
    const epoch = ++requestEpoch.current;
    const current = () =>
      mounted.current &&
      latest.current === started &&
      requestEpoch.current === epoch;
    setBusy(true);
    setError(null);
    setAsked(false);
    // Taking the dock window over from a tab of the same browser: that tab's
    // page stays in view until this one replaces it.
    let finish = () => {};
    if (connectionId && handoverFrom(holders.others(tab.id), connectionId)) {
      const handover = {
        connectionId,
        done: new Promise<void>((resolve) => {
          finish = () => resolve();
        }),
      };
      handovers.add(handover);
      const settle = finish;
      finish = () => {
        handovers.delete(handover);
        settle();
      };
    }
    try {
      const result = await exclusiveDock(async () => {
        for (let attempt = 0; ; attempt++) {
          // A shown panel may have kept or taken the page meanwhile.
          if (!requested && holders.heldElsewhere(tab.id)) return null;
          const others = holders.others(tab.id);
          const from =
            attempt === 0 ? handoverFrom(others, connectionId) : null;
          if (!from)
            for (const previous of others)
              await previous.release().catch(() => {});
          if (!current()) return null;
          try {
            return await call(
              "attach",
              null,
              orderedLayout(measure()),
              from?.dockId,
            );
          } catch (cause) {
            // A dock this window has not heard of yet, as right after a
            // reload: its own tab reports it within a moment.
            if (attempt > 0 || !/one docked tab/i.test(String(cause)))
              throw cause;
            await new Promise((resolve) => setTimeout(resolve, 400));
          }
        }
      });
      if (!result) return;
      if (current()) apply(result);
      else if (result.dockId)
        void call("release", result.dockId).catch(() => {});
    } catch (cause) {
      if (current()) {
        setError(String(cause));
        setHold("failed");
      }
    } finally {
      finish();
      if (current()) setBusy(false);
    }
  }, [call, apply, measure, tab.id, connectionId]);

  const wanted = shouldAttachDock({
    visible,
    connected: Boolean(external?.connected),
    focused: focused || asked,
    presented,
    checked,
    docked: Boolean(dockId),
    busy,
    held: hold !== null,
    elsewhere: elsewhere && !asked,
  });
  const attachRef = useRef(attach);
  attachRef.current = attach;
  useEffect(() => {
    if (wanted) void attachRef.current();
  }, [wanted]);

  const retry = useCallback(() => {
    setError(null);
    setHold(null);
    setAsked(true);
  }, []);

  // An agent's pointer input brought this tab forward and waits for its page.
  useEffect(
    () =>
      subscribeBrowserTabShown((id) => {
        if (id === tab.id) retry();
      }),
    [tab.id, retry],
  );

  return {
    surface,
    dockId,
    live: presenting,
    reason,
    busy,
    error,
    hold,
    // Shown and connected, but another tab's shown panel has the page.
    elsewhere:
      !dockId &&
      !busy &&
      hold === null &&
      visible &&
      Boolean(external?.connected) &&
      elsewhere,
    // Shown and connected, but Anbo is not in front yet.
    waiting:
      !dockId &&
      !busy &&
      hold === null &&
      visible &&
      Boolean(external?.connected) &&
      (!focused || !presented),
    retry,
  };
}
