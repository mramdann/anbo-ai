import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import type { SidebarViewId } from "./types";

export const SIDEBAR_DEFAULT_WIDTH = 260;
export const SIDEBAR_MIN_WIDTH = 220;
export const SIDEBAR_MAX_WIDTH = 480;
const SIDEBAR_WIDTH_STORAGE_KEY = "anbo.sidebar.width";
const SIDEBAR_VIEW_STORAGE_KEY = "anbo.sidebar.view";
const SIDEBAR_COLLAPSED_STORAGE_KEY = "anbo.sidebar.collapsed";

export function shouldPersistSidebarWidth(
  width: number,
  isUserInteraction: boolean,
): boolean {
  return isUserInteraction && width > 0;
}

export function shouldPersistSidebarCollapsed(
  isUserInteraction: boolean,
): boolean {
  return isUserInteraction;
}

export function shouldRestoreSidebar(
  intendedCollapsed: boolean,
  panelCollapsed: boolean,
  documentVisible: boolean,
  viewportWidth: number,
): boolean {
  return (
    !intendedCollapsed &&
    panelCollapsed &&
    documentVisible &&
    viewportWidth >= SIDEBAR_MIN_WIDTH + 320
  );
}

function clampSidebarWidth(width: number): number {
  return Math.min(
    SIDEBAR_MAX_WIDTH,
    Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)),
  );
}

function readSidebarWidth(): number {
  try {
    const stored = window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
    const parsed = stored ? Number.parseInt(stored, 10) : NaN;
    return Number.isFinite(parsed)
      ? clampSidebarWidth(parsed)
      : SIDEBAR_DEFAULT_WIDTH;
  } catch {
    return SIDEBAR_DEFAULT_WIDTH;
  }
}

function readSidebarView(): SidebarViewId {
  try {
    const stored = window.localStorage.getItem(SIDEBAR_VIEW_STORAGE_KEY);
    if (stored === "explorer" || stored === "source-control") return stored;
  } catch {
    // ignore
  }
  return "explorer";
}

function readSidebarCollapsed(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

type FocusableExplorer = {
  focus: () => void;
  isFocused: () => boolean;
};

function expandSidebar(panel: PanelImperativeHandle, width: number): void {
  panel.expand();
  panel.resize(`${width}px`);
}

export function useSidebarPanel(
  explorerRef: RefObject<FocusableExplorer | null>,
) {
  const sidebarRef = useRef<PanelImperativeHandle | null>(null);
  const sidebarWidthRef = useRef(readSidebarWidth());
  const sidebarWidthWriteTimerRef = useRef(0);
  const sidebarRestoreTimerRef = useRef(0);
  const explorerReturnFocusRef = useRef<HTMLElement | null>(null);
  const [sidebarView, setSidebarViewState] =
    useState<SidebarViewId>(readSidebarView);
  const [initialSidebarCollapsed] = useState(readSidebarCollapsed);
  const collapsedRef = useRef(initialSidebarCollapsed);

  const persistSidebarView = useCallback((view: SidebarViewId) => {
    setSidebarViewState(view);
    try {
      window.localStorage.setItem(SIDEBAR_VIEW_STORAGE_KEY, view);
    } catch {
      // storage may fail in private mode
    }
  }, []);

  const persistSidebarCollapsed = useCallback(
    (collapsed: boolean, isUserInteraction = true) => {
      if (
        !shouldPersistSidebarCollapsed(isUserInteraction) ||
        collapsedRef.current === collapsed
      ) {
        return;
      }
      collapsedRef.current = collapsed;
      try {
        window.localStorage.setItem(
          SIDEBAR_COLLAPSED_STORAGE_KEY,
          collapsed ? "1" : "0",
        );
      } catch {
        // storage may fail in private mode
      }
    },
    [],
  );

  const toggleSidebar = useCallback(() => {
    const panel = sidebarRef.current;
    if (!panel) return;
    if (panel.isCollapsed()) {
      expandSidebar(panel, sidebarWidthRef.current);
      persistSidebarCollapsed(false);
    } else {
      panel.collapse();
      persistSidebarCollapsed(true);
    }
  }, [persistSidebarCollapsed]);

  const cycleSidebarView = useCallback(
    (view: SidebarViewId) => {
      const panel = sidebarRef.current;
      const collapsed = panel?.isCollapsed() ?? false;
      if (collapsed) {
        if (panel) expandSidebar(panel, sidebarWidthRef.current);
        persistSidebarCollapsed(false);
        if (view !== sidebarView) persistSidebarView(view);
        return;
      }
      if (view === sidebarView) {
        panel?.collapse();
        persistSidebarCollapsed(true);
        return;
      }
      persistSidebarView(view);
    },
    [persistSidebarCollapsed, persistSidebarView, sidebarView],
  );

  const persistSidebarWidth = useCallback(
    (next: number, isUserInteraction: boolean) => {
      if (!shouldPersistSidebarWidth(next, isUserInteraction)) return;
      sidebarWidthRef.current = next;
      if (sidebarWidthWriteTimerRef.current) {
        window.clearTimeout(sidebarWidthWriteTimerRef.current);
      }
      sidebarWidthWriteTimerRef.current = window.setTimeout(() => {
        sidebarWidthWriteTimerRef.current = 0;
        try {
          window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(next));
        } catch {
          // ignore
        }
      }, 200);
    },
    [],
  );

  const scheduleSidebarRestore = useCallback(() => {
    if (sidebarRestoreTimerRef.current) {
      window.clearTimeout(sidebarRestoreTimerRef.current);
    }
    sidebarRestoreTimerRef.current = window.setTimeout(() => {
      sidebarRestoreTimerRef.current = 0;
      const panel = sidebarRef.current;
      if (
        !panel ||
        !shouldRestoreSidebar(
          collapsedRef.current,
          panel.isCollapsed(),
          document.visibilityState === "visible",
          window.innerWidth,
        )
      ) {
        return;
      }
      expandSidebar(panel, sidebarWidthRef.current);
    }, 120);
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlistenResize: (() => void) | undefined;
    window.addEventListener("resize", scheduleSidebarRestore, {
      passive: true,
    });
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") scheduleSidebarRestore();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    void getCurrentWindow()
      .onResized(scheduleSidebarRestore)
      .then((unlisten) => {
        if (disposed) unlisten();
        else unlistenResize = unlisten;
      });
    return () => {
      disposed = true;
      unlistenResize?.();
      window.removeEventListener("resize", scheduleSidebarRestore);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [scheduleSidebarRestore]);

  useEffect(() => {
    return () => {
      if (sidebarWidthWriteTimerRef.current) {
        window.clearTimeout(sidebarWidthWriteTimerRef.current);
      }
      if (sidebarRestoreTimerRef.current) {
        window.clearTimeout(sidebarRestoreTimerRef.current);
      }
    };
  }, []);

  const toggleExplorerFocus = useCallback(() => {
    const explorer = explorerRef.current;
    const panel = sidebarRef.current;
    const collapsed = panel?.isCollapsed() ?? false;
    if (sidebarView !== "explorer" || collapsed) {
      if (panel && collapsed) {
        expandSidebar(panel, sidebarWidthRef.current);
        persistSidebarCollapsed(false);
      }
      if (sidebarView !== "explorer") persistSidebarView("explorer");
      const active = document.activeElement;
      explorerReturnFocusRef.current =
        active instanceof HTMLElement && active !== document.body
          ? active
          : null;
      requestAnimationFrame(() => explorerRef.current?.focus());
      return;
    }
    if (!explorer) return;
    if (explorer.isFocused()) {
      const target = explorerReturnFocusRef.current;
      explorerReturnFocusRef.current = null;
      if (target && document.body.contains(target)) {
        target.focus();
      } else {
        (document.activeElement as HTMLElement | null)?.blur?.();
      }
      return;
    }
    const active = document.activeElement;
    explorerReturnFocusRef.current =
      active instanceof HTMLElement && active !== document.body ? active : null;
    explorer.focus();
  }, [explorerRef, persistSidebarCollapsed, persistSidebarView, sidebarView]);

  return {
    sidebarRef,
    sidebarWidthRef,
    sidebarView,
    initialSidebarCollapsed,
    persistSidebarView,
    persistSidebarCollapsed,
    toggleSidebar,
    cycleSidebarView,
    persistSidebarWidth,
    toggleExplorerFocus,
  };
}
