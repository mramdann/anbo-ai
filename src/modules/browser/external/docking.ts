import type { BrowserTab } from "@/modules/tabs";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";

type Bounds = { x: number; y: number; width: number; height: number };
export type DockLayout = Bounds & { visible: boolean };
type OrderedLayout = DockLayout & { revision: number };
let lastRevision = 0;
export function orderedLayout(layout: DockLayout): OrderedLayout {
  lastRevision = Math.max(lastRevision + 1, Date.now() * 1000);
  return { ...layout, revision: lastRevision };
}
type Status = { dockId: string | null };

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
const overlays =
  '[role="dialog"], [role="alertdialog"], [role="menu"], [role="tooltip"], [data-radix-popper-content-wrapper], [data-ai-mini-window][data-state="open"], [data-anbo-voice-overlay]';

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
  write: (layout: OrderedLayout) => Promise<Status>,
  settled: (status: Status) => void,
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

export function panelLayout(
  rect: Bounds,
  ratio: number,
  visible: boolean,
): DockLayout {
  const values = [rect.x, rect.y, rect.width, rect.height, ratio];
  if (
    values.some((value) => !Number.isFinite(value)) ||
    ratio <= 0 ||
    ratio > 8
  )
    return { x: 0, y: 0, width: 0, height: 0, visible: false };
  const bounds = {
    x: Math.round(rect.x * ratio),
    y: Math.round(rect.y * ratio),
    width: Math.round(rect.width * ratio),
    height: Math.round(rect.height * ratio),
  };
  if (Object.values(bounds).some((value) => value < 0 || value > 16384))
    return { x: 0, y: 0, width: 0, height: 0, visible: false };
  return {
    ...bounds,
    visible: visible && bounds.width >= 400 && bounds.height >= 300,
  };
}

export function useBrowserDock(tab: BrowserTab, visible: boolean) {
  const surface = useRef<HTMLDivElement>(null);
  const [dockId, setDockId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const external = tab.external;
  const identity = `${tab.id}:${external?.connectionId}:${external?.selectionId}`;
  const latest = useRef(identity);
  const requestEpoch = useRef(0);
  latest.current = identity;

  const call = useCallback(
    (action: string, id: string | null, layout?: OrderedLayout) =>
      invoke<Status>("browser_external_dock", {
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

  const measure = useCallback(() => {
    const rect = surface.current?.getBoundingClientRect();
    if (!rect)
      return panelLayout({ x: 0, y: 0, width: 0, height: 0 }, 1, false);
    const covered = [...document.querySelectorAll<HTMLElement>(overlays)].some(
      (element) => {
        const overlay = element.getBoundingClientRect();
        if (
          !overlay.width ||
          !overlay.height ||
          overlay.left >= rect.right ||
          overlay.right <= rect.left ||
          overlay.top >= rect.bottom ||
          overlay.bottom <= rect.top
        )
          return false;
        const style = getComputedStyle(element);
        return style.display !== "none" && style.visibility !== "hidden";
      },
    );
    return panelLayout(rect, window.devicePixelRatio || 1, visible && !covered);
  }, [visible]);

  useEffect(() => {
    let cancelled = false;
    const epoch = ++requestEpoch.current;
    setDockId(null);
    setBusy(false);
    setError(null);
    if (external?.connected)
      void call("status", null)
        .then((status) => {
          if (!cancelled && requestEpoch.current === epoch)
            setDockId(status.dockId);
        })
        .catch((cause) => {
          if (!cancelled && requestEpoch.current === epoch)
            setError(String(cause));
        });
    return () => {
      cancelled = true;
      requestEpoch.current += 1;
    };
  }, [call, external?.connected]);

  useEffect(() => {
    if (!dockId) return;
    let cancelled = false;
    const listener = listen<{ tabId: number; dockId: string }>(
      "anbo:browser-dock-released",
      ({ payload }) => {
        if (!cancelled && payload.tabId === tab.id && payload.dockId === dockId)
          setDockId(null);
      },
    );
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
      void listener.then(
        (unlisten) => unlisten(),
        () => {},
      );
    };
  }, [dockId, tab.id]);

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
        if (!status.dockId) setDockId(null);
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
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    document.addEventListener("transitionend", schedule, true);
    update();
    return () => {
      stopped = true;
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
      mutations.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      document.removeEventListener("transitionend", schedule, true);
      void publisher.stop(measure());
    };
  }, [dockId, external?.connected, measure, call, visible]);

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
        setDockId(result.dockId);
    } catch (cause) {
      if (latest.current === started && requestEpoch.current === epoch)
        setError(String(cause));
    } finally {
      if (latest.current === started && requestEpoch.current === epoch)
        setBusy(false);
    }
  };

  return { surface, dockId, busy, error, toggle };
}
