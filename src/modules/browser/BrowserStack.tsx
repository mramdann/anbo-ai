import { cn } from "@/lib/utils";
import type { BrowserTab, Tab } from "@/modules/tabs";
import { type CSSProperties, lazy, Suspense, useEffect, useRef } from "react";
import { BrowserPane, type BrowserPaneHandle } from "./BrowserPane";
import type { BrowserWorkspaceContext } from "./native";
const ExternalBrowserPane = lazy(
  () => import("@/modules/browser/external/ExternalBrowserPane"),
);

type Props = {
  tabs: Tab[];
  activeId: number;
  onUrlChange: (id: number, url: string) => void;
  onTitleChange: (id: number, title: string) => void;
  onLoadingChange: (id: number, loading: boolean) => void;
  /** A tab's page took focus, so that tab is the one being used. */
  onActivate?: (id: number) => void;
  getWorkspaceContext: (spaceId: string) => BrowserWorkspaceContext;
  registerHandle: (
    id: number,
    handle: BrowserPaneHandle | null,
    previous?: BrowserPaneHandle | null,
  ) => void;
  /** Hidden panes of this space keep the size of the box they render in. */
  followSpaceId?: string | null;
  /** Where a hidden pane of another space sits instead of the whole host: the
   *  box it comes forward in once its own space is shown (savedDockArea). */
  paneStyles?: ReadonlyMap<number, CSSProperties>;
};

export function selectBackgroundBrowserTabs(
  tabs: Tab[],
  visibleTabIds: ReadonlySet<number>,
): BrowserTab[] {
  return tabs.filter(
    (tab): tab is BrowserTab =>
      tab.kind === "browser" && !tab.cold && !visibleTabIds.has(tab.id),
  );
}

/** Whether a pane follows the size of its box while hidden: only a tab of
 *  the space in view. The hidden host takes its box from that space's dock,
 *  so a tab of another space following it would lay out its page again on
 *  every space switch; it keeps its size until its own space is shown, the
 *  size it was shown at or, never shown, the one its space's saved layout
 *  gives it (paneStyles). */
export function followsHostSize(
  tab: BrowserTab,
  visible: boolean,
  followSpaceId: string | null | undefined,
): boolean {
  return !visible && followSpaceId != null && tab.spaceId === followSpaceId;
}

export function browserPaneInitialLoading(tab: BrowserTab): boolean {
  return tab.loading ?? !!tab.url;
}

export function BrowserStack({
  tabs,
  activeId,
  onUrlChange,
  onTitleChange,
  onLoadingChange,
  onActivate,
  getWorkspaceContext,
  registerHandle,
  followSpaceId,
  paneStyles,
}: Props) {
  const browserTabs = tabs.filter(
    (t): t is BrowserTab => t.kind === "browser" && !t.cold,
  );

  const registerRef = useRef(registerHandle);
  const urlChangeRef = useRef(onUrlChange);
  const titleChangeRef = useRef(onTitleChange);
  const loadingChangeRef = useRef(onLoadingChange);
  const activateRef = useRef(onActivate);
  useEffect(() => {
    activateRef.current = onActivate;
  }, [onActivate]);
  useEffect(() => {
    registerRef.current = registerHandle;
  }, [registerHandle]);
  useEffect(() => {
    urlChangeRef.current = onUrlChange;
  }, [onUrlChange]);
  useEffect(() => {
    titleChangeRef.current = onTitleChange;
  }, [onTitleChange]);
  useEffect(() => {
    loadingChangeRef.current = onLoadingChange;
  }, [onLoadingChange]);

  const refCallbacks = useRef(
    new Map<number, (h: BrowserPaneHandle | null) => void>(),
  );
  const urlCallbacks = useRef(new Map<number, (url: string) => void>());
  const titleCallbacks = useRef(new Map<number, (title: string) => void>());
  const loadingCallbacks = useRef(
    new Map<number, (loading: boolean) => void>(),
  );
  // Stable per tab like the others, so a memoized pane skips the renders the
  // app does for every title, URL and loading change of any tab.
  const activateCallbacks = useRef(new Map<number, () => void>());

  const getRefCallback = (id: number) => {
    let cb = refCallbacks.current.get(id);
    if (!cb) {
      let current: BrowserPaneHandle | null = null;
      cb = (handle: BrowserPaneHandle | null) => {
        const previous = current;
        current = handle;
        registerRef.current(id, handle, previous);
      };
      refCallbacks.current.set(id, cb);
    }
    return cb;
  };
  const getUrlCallback = (id: number) => {
    let cb = urlCallbacks.current.get(id);
    if (!cb) {
      cb = (url: string) => urlChangeRef.current(id, url);
      urlCallbacks.current.set(id, cb);
    }
    return cb;
  };
  const getTitleCallback = (id: number) => {
    let cb = titleCallbacks.current.get(id);
    if (!cb) {
      cb = (title: string) => titleChangeRef.current(id, title);
      titleCallbacks.current.set(id, cb);
    }
    return cb;
  };
  const getLoadingCallback = (id: number) => {
    let cb = loadingCallbacks.current.get(id);
    if (!cb) {
      cb = (loading: boolean) => loadingChangeRef.current(id, loading);
      loadingCallbacks.current.set(id, cb);
    }
    return cb;
  };
  const getActivateCallback = (id: number) => {
    let cb = activateCallbacks.current.get(id);
    if (!cb) {
      cb = () => activateRef.current?.(id);
      activateCallbacks.current.set(id, cb);
    }
    return cb;
  };

  useEffect(() => {
    const live = new Set(browserTabs.map((t) => t.id));
    for (const id of refCallbacks.current.keys()) {
      if (!live.has(id)) refCallbacks.current.delete(id);
    }
    for (const id of urlCallbacks.current.keys()) {
      if (!live.has(id)) urlCallbacks.current.delete(id);
    }
    for (const id of titleCallbacks.current.keys()) {
      if (!live.has(id)) titleCallbacks.current.delete(id);
    }
    for (const id of loadingCallbacks.current.keys()) {
      if (!live.has(id)) loadingCallbacks.current.delete(id);
    }
    for (const id of activateCallbacks.current.keys()) {
      if (!live.has(id)) activateCallbacks.current.delete(id);
    }
  }, [browserTabs]);

  if (browserTabs.length === 0) return null;
  return (
    <div className="relative h-full w-full">
      {browserTabs.map((t) => {
        const visible = t.id === activeId;
        const context = getWorkspaceContext(t.spaceId);
        return (
          <div
            key={t.id}
            className={cn(
              "absolute inset-0",
              !visible && "invisible pointer-events-none",
            )}
            style={visible ? undefined : paneStyles?.get(t.id)}
            aria-hidden={!visible}
          >
            {t.external ? (
              <Suspense fallback={null}>
                <ExternalBrowserPane
                  ref={getRefCallback(t.id)}
                  tab={t}
                  visible={visible}
                  workspaceRoot={context.root}
                />
              </Suspense>
            ) : (
              <BrowserPane
                ref={getRefCallback(t.id)}
                id={t.id}
                url={t.url}
                visible={visible}
                workspaceRoot={context.root}
                workspace={context.workspace}
                initialLoading={browserPaneInitialLoading(t)}
                onUrlChange={getUrlCallback(t.id)}
                onTitleChange={getTitleCallback(t.id)}
                onLoadingChange={getLoadingCallback(t.id)}
                onActivate={getActivateCallback(t.id)}
                followHidden={followsHostSize(t, visible, followSpaceId)}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
