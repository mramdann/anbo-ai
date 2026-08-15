import { cn } from "@/lib/utils";
import type { BrowserTab, Tab } from "@/modules/tabs";
import { useEffect, useRef } from "react";
import { BrowserPane, type BrowserPaneHandle } from "./BrowserPane";
import type { BrowserWorkspaceContext } from "./native";

type Props = {
  tabs: Tab[];
  activeId: number;
  onUrlChange: (id: number, url: string) => void;
  onTitleChange: (id: number, title: string) => void;
  onLoadingChange: (id: number, loading: boolean) => void;
  getWorkspaceContext: (spaceId: string) => BrowserWorkspaceContext;
  registerHandle: (
    id: number,
    handle: BrowserPaneHandle | null,
    previous?: BrowserPaneHandle | null,
  ) => void;
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

export function browserPaneInitialLoading(tab: BrowserTab): boolean {
  return tab.loading ?? !!tab.url;
}

export function BrowserStack({
  tabs,
  activeId,
  onUrlChange,
  onTitleChange,
  onLoadingChange,
  getWorkspaceContext,
  registerHandle,
}: Props) {
  const browserTabs = tabs.filter(
    (t): t is BrowserTab => t.kind === "browser" && !t.cold,
  );

  const registerRef = useRef(registerHandle);
  const urlChangeRef = useRef(onUrlChange);
  const titleChangeRef = useRef(onTitleChange);
  const loadingChangeRef = useRef(onLoadingChange);
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
            aria-hidden={!visible}
          >
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
            />
          </div>
        );
      })}
    </div>
  );
}
