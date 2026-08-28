import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import {
  isWindowPresentationBlocked,
  subscribeWindowPresentation,
} from "@/lib/windowPresentation";
import type { AgentLaunchRequest } from "@/modules/agents/lib/launcher";
import {
  ALL_LANGUAGES,
  EXPOSED_LANGUAGES,
} from "@/modules/editor/lib/languageDefinitions";
import { resolveDisplayName } from "@/modules/editor/lib/languageResolver";
import { fileIconUrl } from "@/modules/explorer/lib/iconResolver";
import {
  BotIcon,
  Cancel01Icon,
  FullScreenIcon,
  Minimize01Icon,
  MoreHorizontalIcon,
  PencilEdit02Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  type DockviewApi,
  type DockviewGroupPanel,
  DockviewReact,
  type DockviewReadyEvent,
  type IDockviewHeaderActionsProps,
  type IDockviewPanelHeaderProps,
  type IDockviewPanelProps,
} from "dockview-react";
import "dockview/dist/styles/dockview.css";
import { useBrowserAutomationActivity } from "@/modules/browser/automationActivity";
import { setNativeBrowserDragActive } from "@/modules/browser/nativeVisibility";
import {
  createContext,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { labelFor } from "./lib/tabLabel";
import { countClippedTabs, formatClippedTabCount } from "./lib/tabOverflow";
import type { EditorTab, Tab } from "./lib/useTabs";
import {
  calculateLinearReorderGap,
  resolveWorkspaceDockviewEdgeZone,
  resolveWorkspaceDockviewHeaderTarget,
  type WorkspaceDockviewEdgeZone,
  workspaceDockviewEdgePreviewRect,
} from "./lib/workspaceDockviewDrag";
import {
  WORKSPACE_DOCKVIEW_COMPONENT,
  workspaceDockviewInsertionPosition,
  workspaceDockviewPanelId,
  workspaceTabsToDockviewLayout,
} from "./lib/workspaceDockviewLayout";
import {
  readWorkspaceDockviewLayout,
  workspaceDockviewLayoutIdentities,
  writeWorkspaceDockviewLayout,
} from "./lib/workspaceDockviewPersistence";
import { NewTabMenu } from "./NewTabMenu";
import { TabIcon } from "./TabIcon";
import "./WorkspaceDockview.css";

export type WorkspaceDockviewProps = {
  spaceId: string;
  tabs: Tab[];
  activeId: number;
  onSelect: (id: number) => void;
  onRevealTab: (id: number) => void;
  onTabVisibilityChange: (id: number, visible: boolean) => void;
  onNew: () => void;
  onNewBlock: () => void;
  onNewPrivate: () => void;
  onNewBrowser: () => void;
  onNewEditor: () => void;
  onNewGitGraph: () => void;
  onLaunchAgents: (request: AgentLaunchRequest) => void;
  onClose: (id: number) => void;
  onPin: (id: number) => void;
  onRename: (id: number, title: string) => void;
  onReorder: (fromId: number, toGapIndex: number) => void;
  onOverrideLanguage?: (id: number, lang: string | null) => void;
  hideTabs?: boolean;
  externalMoves?: readonly {
    tabId: number;
    targetTabId: number;
    placement: "before" | "after";
    spaceId: string;
    revision: number;
  }[];
  externalSplits?: readonly {
    tabId: number;
    referenceTabId: number;
    position: "right" | "bottom";
    spaceId: string;
    revision: number;
  }[];
  onLayoutSettled?: () => void;
  /** Render one tab's content directly inside its dockview panel (flat model). */
  renderTab: (tab: Tab, visible: boolean) => ReactNode;
};

type WorkspaceDockviewContextValue = WorkspaceDockviewProps & {
  draggingTabId: number | null;
  onTabPointerDown: (
    event: ReactPointerEvent<HTMLElement>,
    panelId: string,
    tabId: number,
    label: string,
  ) => void;
};

type PointerDropTarget =
  | {
      kind: "header";
      group: DockviewGroupPanel;
      index: number;
      targetTabId: number | null;
      placement: "before" | "after";
    }
  | {
      kind: "edge";
      group: DockviewGroupPanel;
      zone: WorkspaceDockviewEdgeZone;
    };

type DropPreview = {
  kind: "header" | "edge";
  left: number;
  top: number;
  width: number;
  height: number;
};

type DragGhost = {
  label: string;
  width: number;
  height: number;
};

const POINTER_DRAG_THRESHOLD = 4;
const LAYOUT_WRITE_DEBOUNCE_MS = 200;

const WorkspaceDockviewContext =
  createContext<WorkspaceDockviewContextValue | null>(null);

const workspaceTheme = {
  name: "anbo-workspace",
  className: "dockview-theme-anbo-workspace",
};

const components = {
  [WORKSPACE_DOCKVIEW_COMPONENT]: WorkspacePanel,
};

function useWorkspaceDockviewContext(): WorkspaceDockviewContextValue {
  const value = useContext(WorkspaceDockviewContext);
  if (!value) throw new Error("WorkspaceDockview context is unavailable");
  return value;
}

function tabIdForParams(params: { tabId?: unknown }): number | null {
  return typeof params.tabId === "number" ? params.tabId : null;
}

function WorkspacePanel(props: IDockviewPanelProps<{ tabId: number }>) {
  const { onRevealTab, onTabVisibilityChange, renderTab, tabs } =
    useWorkspaceDockviewContext();
  const [visible, setVisible] = useState(props.api.isVisible);
  useLayoutEffect(() => {
    setVisible(props.api.isVisible);
    const d = props.api.onDidVisibilityChange((e) => setVisible(e.isVisible));
    return () => d.dispose();
  }, [props.api]);
  const tabId =
    typeof props.params.tabId === "number" ? props.params.tabId : null;
  const tab = tabId !== null ? tabs.find((t) => t.id === tabId) : undefined;
  useEffect(() => {
    if (visible && tabId !== null) onRevealTab(tabId);
  }, [onRevealTab, tabId, visible]);
  useLayoutEffect(() => {
    if (tabId === null) return;
    onTabVisibilityChange(tabId, visible);
    return () => onTabVisibilityChange(tabId, false);
  }, [onTabVisibilityChange, tabId, visible]);
  return (
    <div
      className="anbo-workspace-panel h-full"
      data-workspace-dockview-tab={props.params.tabId}
    >
      {tab ? renderTab(tab, visible) : null}
    </div>
  );
}

function WorkspaceDockviewActions(props: IDockviewHeaderActionsProps) {
  const context = useWorkspaceDockviewContext();
  const [maximized, setMaximized] = useState(props.api.isMaximized());
  const [overflowCount, setOverflowCount] = useState(0);

  useEffect(() => {
    setMaximized(props.api.isMaximized());
    const changed = props.containerApi.onDidMaximizedGroupChange(() => {
      setMaximized(props.api.isMaximized());
    });
    return () => changed.dispose();
  }, [props.api, props.containerApi]);

  const groupPanels = props.group.panels;

  const checkOverflow = useCallback(() => {
    const header =
      props.group.element.querySelector<HTMLElement>(".dv-tabs-container");
    if (!header) {
      setOverflowCount(0);
      return;
    }
    const container = header.getBoundingClientRect();
    const tabs = Array.from(
      header.querySelectorAll<HTMLElement>(".dv-tab"),
      (tab) => tab.getBoundingClientRect(),
    );
    setOverflowCount(countClippedTabs(container, tabs));
  }, [props.group.element]);

  useLayoutEffect(() => {
    checkOverflow();
    const header =
      props.group.element.querySelector<HTMLElement>(".dv-tabs-container");
    if (!header) return;

    const observer = new ResizeObserver(() => checkOverflow());
    const mutations = new MutationObserver(() => checkOverflow());
    observer.observe(header);
    observer.observe(props.group.element);
    mutations.observe(header, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    header.addEventListener("scroll", checkOverflow, { passive: true });

    return () => {
      observer.disconnect();
      mutations.disconnect();
      header.removeEventListener("scroll", checkOverflow);
    };
  }, [props.group.element, checkOverflow]);

  return (
    <div
      className="anbo-workspace-dockview-actions"
      onPointerDownCapture={() => {
        if (props.containerApi.activeGroup !== props.group) {
          props.activePanel?.api.setActive();
        }
      }}
    >
      {overflowCount > 0 && groupPanels.length > 1 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={`List ${overflowCount} hidden tabs`}
              title={`${overflowCount} hidden tabs`}
              className="flex h-7 w-auto min-w-7 shrink-0 items-center justify-center gap-0.5 rounded-md px-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              onPointerDown={(e) => e.stopPropagation()}
            >
              <HugeiconsIcon
                icon={MoreHorizontalIcon}
                size={13}
                strokeWidth={1.8}
                aria-hidden
              />
              <span className="leading-none text-[9px] font-semibold tabular-nums">
                {formatClippedTabCount(overflowCount)}
              </span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            side="bottom"
            sideOffset={6}
            className="max-h-75 w-56 overflow-y-auto rounded-xl border border-border/40 bg-popover/95 p-1 shadow-lg backdrop-blur-md"
            onClick={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
          >
            {groupPanels.map((panel) => {
              const tabId = tabIdForParams(panel.params ?? {});
              const tab = context.tabs.find(
                (candidate) => candidate.id === tabId,
              );
              if (!tab) return null;
              const isActive = panel.api.isActive;
              return (
                <DropdownMenuItem
                  key={panel.id}
                  aria-current={isActive ? "page" : undefined}
                  onSelect={() => {
                    panel.api.setActive();
                    if (tabId !== null) context.onSelect(tabId);
                  }}
                  className={cn(
                    "flex cursor-default items-center gap-1.5 rounded-md px-1.5 py-1 text-[11px] focus:bg-accent focus:text-accent-foreground",
                    isActive && "bg-accent/55 text-foreground",
                  )}
                >
                  <TabIcon tab={tab} size="sm" />
                  <span
                    className={cn(
                      "flex-1 truncate",
                      isActive && "font-medium text-foreground",
                    )}
                  >
                    {labelFor(tab)}
                  </span>
                  {isActive ? (
                    <HugeiconsIcon
                      icon={Tick02Icon}
                      className="size-3.5 text-primary"
                    />
                  ) : null}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}

      <NewTabMenu
        onNew={context.onNew}
        onNewBlock={context.onNewBlock}
        onNewPrivate={context.onNewPrivate}
        onNewBrowser={context.onNewBrowser}
        onNewEditor={context.onNewEditor}
        onNewGitGraph={context.onNewGitGraph}
        onLaunchAgents={context.onLaunchAgents}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={maximized ? "Restore panel" : "Fullscreen panel"}
        title={maximized ? "Restore panel" : "Fullscreen panel"}
        className="size-7 shrink-0 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        onClick={(event) => {
          event.stopPropagation();
          if (props.api.isMaximized()) props.api.exitMaximized();
          else props.api.maximize();
        }}
      >
        <HugeiconsIcon
          icon={maximized ? Minimize01Icon : FullScreenIcon}
          size={14}
          strokeWidth={1.8}
        />
      </Button>
    </div>
  );
}

function BrowserAutomationTabIndicator({ tabId }: { tabId: number }) {
  const action = useBrowserAutomationActivity(tabId);
  if (!action) return null;

  return (
    <span
      data-no-drag
      role="status"
      aria-label={`Agent is automating this browser: ${action}`}
      title={`Agent is automating this browser: ${action}`}
      className="anbo-browser-automation-indicator"
    >
      <HugeiconsIcon
        icon={BotIcon}
        size={11}
        strokeWidth={1.8}
        className="anbo-browser-automation-robot"
      />
    </span>
  );
}

function WorkspaceDockviewTab(
  props: IDockviewPanelHeaderProps<{ tabId: number }>,
) {
  const context = useWorkspaceDockviewContext();
  const [editing, setEditing] = useState(false);
  const tabId = tabIdForParams(props.params);
  const tab = context.tabs.find((candidate) => candidate.id === tabId);
  if (!tab) return null;

  const preview =
    (tab.kind === "editor" || tab.kind === "git-diff") && tab.preview;
  const tabContent = (
    // biome-ignore lint/a11y/noStaticElementInteractions: Dockview owns the keyboard-accessible tab wrapper.
    <div
      className={cn(
        "anbo-workspace-dockview-tab",
        context.draggingTabId === tab.id &&
          "anbo-workspace-dockview-tab-dragging",
      )}
      data-workspace-dockview-panel-id={props.api.id}
      data-workspace-dockview-tab-id={tab.id}
      data-workspace-dockview-tab-kind={tab.kind}
      onPointerDown={(event) =>
        context.onTabPointerDown(event, props.api.id, tab.id, labelFor(tab))
      }
      onDoubleClick={() => {
        if (preview) context.onPin(tab.id);
      }}
      onAuxClick={(event) => {
        if (event.button !== 1) return;
        if ((event.target as HTMLElement).closest("[data-no-drag]")) return;
        event.preventDefault();
        event.stopPropagation();
        context.onClose(tab.id);
      }}
    >
      <span className="anbo-workspace-dockview-tab-main">
        {tab.kind === "editor" ? (
          <LanguageMenu tab={tab} />
        ) : (
          <TabIcon tab={tab} />
        )}
        {editing && tab.kind === "terminal" ? (
          <TabRenameInput
            initial={labelFor(tab)}
            onCommit={(value) => {
              context.onRename(tab.id, value);
              setEditing(false);
            }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <span className={cn("min-w-0 flex-1 truncate", preview && "italic")}>
            {labelFor(tab)}
          </span>
        )}
        {tab.kind === "browser" ? (
          <BrowserAutomationTabIndicator tabId={tab.id} />
        ) : null}
        {tab.kind === "editor" && tab.dirty ? (
          <span
            title="Unsaved changes"
            className="anbo-workspace-dockview-dirty"
          />
        ) : null}
      </span>
      <button
        type="button"
        aria-label="Close tab"
        data-no-drag
        className="anbo-workspace-dockview-close"
        onPointerDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onClick={(event) => {
          event.stopPropagation();
          context.onClose(tab.id);
        }}
      >
        <HugeiconsIcon icon={Cancel01Icon} size={11} strokeWidth={2} />
      </button>
    </div>
  );

  if (tab.kind !== "terminal") return tabContent;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{tabContent}</ContextMenuTrigger>
      <ContextMenuContent
        className="min-w-32 p-1"
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <ContextMenuItem
          className="gap-2 rounded-xl px-2.5 py-1.5 text-[13px]"
          onSelect={() => setEditing(true)}
        >
          <HugeiconsIcon icon={PencilEdit02Icon} size={13} strokeWidth={1.75} />
          <span className="flex-1">Rename</span>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          className="gap-2 rounded-xl px-2.5 py-1.5 text-[13px]"
          onSelect={() => context.onClose(tab.id)}
        >
          <HugeiconsIcon icon={Cancel01Icon} size={13} strokeWidth={1.75} />
          <span className="flex-1">Close</span>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function LanguageMenu({ tab }: { tab: EditorTab }) {
  const { onOverrideLanguage } = useWorkspaceDockviewContext();
  const [showAllLanguages, setShowAllLanguages] = useState(false);

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (!open) setShowAllLanguages(false);
      }}
    >
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Select editor language"
          data-no-drag
          className="anbo-workspace-dockview-language"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <TabIcon tab={tab} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="bottom"
        sideOffset={6}
        alignOffset={-4}
        className="max-h-75 w-48 overflow-y-auto rounded-xl border border-border/40 bg-popover/90 p-1 shadow-lg backdrop-blur-md"
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <DropdownMenuItem
          onSelect={() => onOverrideLanguage?.(tab.id, null)}
          className="flex cursor-default items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs focus:bg-accent focus:text-accent-foreground"
        >
          <img
            src={fileIconUrl(tab.title)}
            className="size-3.5 shrink-0 object-contain"
            alt=""
          />
          <div className="flex flex-1 flex-col">
            <span>Auto Detect</span>
            <span className="text-[10px] italic text-muted-foreground">
              Mode: {resolveDisplayName(tab.title)}
            </span>
          </div>
          {!tab.overrideLanguage ? (
            <HugeiconsIcon
              icon={Tick02Icon}
              className="size-3.5 text-primary"
            />
          ) : null}
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={(event) => {
            event.preventDefault();
            setShowAllLanguages((value) => !value);
          }}
          className="w-full cursor-default rounded-lg px-2.5 py-1.5 text-left text-xs text-primary/60 transition-colors hover:bg-accent hover:text-primary"
        >
          {showAllLanguages ? "Fewer languages" : "All languages"}
        </DropdownMenuItem>
        <DropdownMenuSeparator className="my-1 border-t border-border/30" />
        {(showAllLanguages ? ALL_LANGUAGES : EXPOSED_LANGUAGES).map(
          (language) => (
            <DropdownMenuItem
              key={language.ext}
              onSelect={() => onOverrideLanguage?.(tab.id, language.ext)}
              className="flex cursor-default items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs focus:bg-accent focus:text-accent-foreground"
            >
              <img
                src={fileIconUrl(`dummy.${language.ext}`)}
                className="size-3.5 shrink-0 object-contain"
                alt=""
              />
              <span className="flex-1">{language.name}</span>
              {tab.overrideLanguage === language.ext ? (
                <HugeiconsIcon
                  icon={Tick02Icon}
                  className="size-3.5 text-primary"
                />
              ) : null}
            </DropdownMenuItem>
          ),
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TabRenameInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const done = useRef(false);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  const finish = (callback: () => void) => {
    if (done.current) return;
    done.current = true;
    callback();
  };
  const commit = (value: string, explicit: boolean) => {
    if (!explicit && value.trim() === initial.trim()) finish(onCancel);
    else finish(() => onCommit(value));
  };

  return (
    <input
      ref={inputRef}
      defaultValue={initial}
      aria-label="Rename tab"
      data-no-drag
      className="anbo-workspace-dockview-rename"
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") commit(event.currentTarget.value, true);
        else if (event.key === "Escape") finish(onCancel);
      }}
      onBlur={(event) => {
        if (!document.hasFocus()) return;
        commit(event.currentTarget.value, false);
      }}
    />
  );
}

function sameDropPreview(a: DropPreview | null, b: DropPreview | null) {
  return (
    a === b ||
    (a !== null &&
      b !== null &&
      a.kind === b.kind &&
      a.left === b.left &&
      a.top === b.top &&
      a.width === b.width &&
      a.height === b.height)
  );
}

function workspaceLayoutStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function setGroupHeadersHidden(api: DockviewApi, hidden: boolean): void {
  for (const group of api.groups) group.header.hidden = hidden;
}

function removeEmptyGroups(api: DockviewApi): void {
  if (api.panels.length === 0) return;
  for (const group of [...api.groups]) {
    if (group.panels.length === 0) api.removeGroup(group);
  }
}

export function WorkspaceDockview({ ...props }: WorkspaceDockviewProps) {
  const [api, setApi] = useState<DockviewApi | null>(null);
  const [dragGhost, setDragGhost] = useState<DragGhost | null>(null);
  const [draggingTabId, setDraggingTabId] = useState<number | null>(null);
  const [dropPreview, setDropPreview] = useState<DropPreview | null>(null);
  const [syncRevision, setSyncRevision] = useState(0);
  const applyingLayout = useRef(false);
  const latest = useRef(props);
  const apiRef = useRef<DockviewApi | null>(null);
  const dockviewElementRef = useRef<HTMLDivElement | null>(null);
  const ghostElRef = useRef<HTMLDivElement | null>(null);
  const ghostOffsetRef = useRef({ x: 0, y: 0 });
  const lastPointerRef = useRef({ x: 0, y: 0 });
  const dropTargetRef = useRef<PointerDropTarget | null>(null);
  const suppressClickRef = useRef(false);
  const cleanupDragRef = useRef<(() => void) | null>(null);
  const handledExternalMoves = useRef(new Map<string, number>());
  const handledExternalSplits = useRef(new Map<string, number>());
  const loadedSpaceRef = useRef<string | null>(null);
  const loadedTabsRef = useRef<readonly Tab[]>([]);
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const layoutSettledFrameRef = useRef(0);
  latest.current = props;
  const layoutKey = `${props.spaceId}:${props.tabs.map((tab) => tab.id).join(",")}`;
  const persistenceTabsKey = JSON.stringify([
    layoutKey,
    workspaceDockviewLayoutIdentities(props.tabs),
  ]);

  const persistLayout = useCallback(
    (currentApi: DockviewApi, spaceId: string) => {
      const storage = workspaceLayoutStorage();
      if (!storage) return;
      try {
        writeWorkspaceDockviewLayout(
          storage,
          spaceId,
          currentApi.toJSON(),
          loadedTabsRef.current,
        );
      } catch {
        // Dockview may already be tearing down; persistence remains best-effort.
      }
    },
    [],
  );

  const flushPersistedLayout = useCallback(
    (spaceId = loadedSpaceRef.current, currentApi = apiRef.current) => {
      if (persistTimerRef.current !== null) {
        clearTimeout(persistTimerRef.current);
        persistTimerRef.current = null;
      }
      if (spaceId !== null && currentApi) persistLayout(currentApi, spaceId);
    },
    [persistLayout],
  );

  const schedulePersistedLayout = useCallback(() => {
    if (persistTimerRef.current !== null) {
      clearTimeout(persistTimerRef.current);
    }
    persistTimerRef.current = setTimeout(() => {
      persistTimerRef.current = null;
      const currentApi = apiRef.current;
      const spaceId = loadedSpaceRef.current;
      if (currentApi && spaceId !== null) persistLayout(currentApi, spaceId);
    }, LAYOUT_WRITE_DEBOUNCE_MS);
  }, [persistLayout]);

  const scheduleLayoutSettled = useCallback(() => {
    if (layoutSettledFrameRef.current) {
      cancelAnimationFrame(layoutSettledFrameRef.current);
    }
    layoutSettledFrameRef.current = requestAnimationFrame(() => {
      layoutSettledFrameRef.current = requestAnimationFrame(() => {
        layoutSettledFrameRef.current = 0;
        latest.current.onLayoutSettled?.();
      });
    });
  }, []);

  const placeGhost = useCallback((clientX: number, clientY: number) => {
    lastPointerRef.current = { x: clientX, y: clientY };
    const ghost = ghostElRef.current;
    if (!ghost) return;
    ghost.style.left = `${clientX - ghostOffsetRef.current.x}px`;
    ghost.style.top = `${clientY - ghostOffsetRef.current.y}px`;
  }, []);

  const ghostRef = useCallback(
    (element: HTMLDivElement | null) => {
      ghostElRef.current = element;
      if (element) {
        placeGhost(lastPointerRef.current.x, lastPointerRef.current.y);
      }
    },
    [placeGhost],
  );

  const updateDropTarget = useCallback(
    (sourcePanelId: string, clientX: number, clientY: number) => {
      const currentApi = apiRef.current;
      const sourcePanel = currentApi?.getPanel(sourcePanelId);
      const hit = document.elementFromPoint(clientX, clientY);
      const group =
        hit && currentApi
          ? currentApi.groups.find(
              (candidate) =>
                candidate.element === hit || candidate.element.contains(hit),
            )
          : undefined;

      const clearTarget = () => {
        dropTargetRef.current = null;
        setDropPreview((current) =>
          sameDropPreview(current, null) ? current : null,
        );
      };

      if (!currentApi || !sourcePanel || !hit || !group) {
        clearTarget();
        return;
      }

      const header = group.element.querySelector<HTMLElement>(
        ":scope > .dv-tabs-and-actions-container",
      );
      if (header?.contains(hit)) {
        const tabElements = Array.from(
          header.querySelectorAll<HTMLElement>(".dv-tabs-container .dv-tab"),
        ).filter(
          (element) =>
            element.closest(".dv-tabs-and-actions-container") === header,
        );
        const entries = tabElements
          .map((element) => {
            const panelId = element
              .querySelector<HTMLElement>("[data-workspace-dockview-panel-id]")
              ?.getAttribute("data-workspace-dockview-panel-id");
            const panel = panelId
              ? group.panels.find((candidate) => candidate.id === panelId)
              : undefined;
            return panel ? { element, panel } : null;
          })
          .filter((entry) => entry !== null);
        const directTab = hit.closest<HTMLElement>(".dv-tab");
        const directEntry = directTab
          ? entries.find((entry) => entry.element === directTab)
          : undefined;

        const headerTarget = resolveWorkspaceDockviewHeaderTarget(
          entries.map((entry) => ({
            tabId: tabIdForParams(entry.panel.params ?? {}) ?? Number.NaN,
            rect: entry.element.getBoundingClientRect(),
          })),
          clientX,
          directEntry ? tabIdForParams(directEntry.panel.params ?? {}) : null,
        );
        if (!headerTarget || Number.isNaN(headerTarget.tabId)) {
          clearTarget();
          return;
        }
        const gapIndex = headerTarget.gapIndex;

        const sourceIndex = group.panels.indexOf(sourcePanel);
        const insertionIndex =
          sourceIndex >= 0 && gapIndex > sourceIndex ? gapIndex - 1 : gapIndex;
        if (sourceIndex >= 0 && insertionIndex === sourceIndex) {
          clearTarget();
          return;
        }

        const targetTabId = headerTarget.tabId;
        const placement = headerTarget.placement;
        const boundaryEntry = entries.find(
          (entry) =>
            tabIdForParams(entry.panel.params ?? {}) === headerTarget.tabId,
        );
        const headerRect = header.getBoundingClientRect();
        const boundaryRect = boundaryEntry?.element.getBoundingClientRect();
        const boundaryX =
          placement === "before"
            ? (boundaryRect?.left ?? headerRect.left + 6)
            : (boundaryRect?.right ?? headerRect.right - 6);
        const preview: DropPreview = {
          kind: "header",
          left: boundaryX - 2,
          top: headerRect.top + 3,
          width: 4,
          height: Math.max(0, headerRect.height - 6),
        };

        dropTargetRef.current = {
          kind: "header",
          group,
          index: insertionIndex,
          targetTabId,
          placement,
        };
        setDropPreview((current) =>
          sameDropPreview(current, preview) ? current : preview,
        );
        return;
      }

      const content = group.element.querySelector<HTMLElement>(
        ":scope > .dv-content-container",
      );
      if (!content?.contains(hit)) {
        clearTarget();
        return;
      }
      const contentRect = content.getBoundingClientRect();
      const zone = resolveWorkspaceDockviewEdgeZone(
        contentRect,
        clientX,
        clientY,
      );
      if (
        !zone ||
        (sourcePanel.api.group === group && group.panels.length === 1)
      ) {
        clearTarget();
        return;
      }

      const groupRect = group.element.getBoundingClientRect();
      const preview = {
        kind: "edge" as const,
        ...workspaceDockviewEdgePreviewRect(groupRect, zone),
      };
      dropTargetRef.current = { kind: "edge", group, zone };
      setDropPreview((current) =>
        sameDropPreview(current, preview) ? current : preview,
      );
    },
    [],
  );

  const onTabPointerDown = useCallback(
    (
      event: ReactPointerEvent<HTMLElement>,
      sourcePanelId: string,
      sourceTabId: number,
      label: string,
    ) => {
      if (
        event.button !== 0 ||
        (event.target as HTMLElement).closest("[data-no-drag]")
      ) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      cleanupDragRef.current?.();
      const pointerId = event.pointerId;
      const pointerTarget = event.currentTarget;
      pointerTarget.setPointerCapture(pointerId);
      const startX = event.clientX;
      const startY = event.clientY;
      const sourceTabRect = event.currentTarget
        .closest<HTMLElement>(".dv-tab")
        ?.getBoundingClientRect();
      const dragRect =
        sourceTabRect ?? event.currentTarget.getBoundingClientRect();
      ghostOffsetRef.current = {
        x: startX - dragRect.left,
        y: startY - dragRect.top,
      };
      let active = false;
      let finished = false;
      const previousUserSelect = document.body.style.userSelect;

      const detach = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", cancel);
        window.removeEventListener("blur", blur);
        document.removeEventListener("visibilitychange", visibilityChange);
      };
      const finish = (commit: boolean) => {
        if (finished) return;
        finished = true;
        detach();
        if (pointerTarget.hasPointerCapture(pointerId)) {
          pointerTarget.releasePointerCapture(pointerId);
        }
        cleanupDragRef.current = null;

        try {
          const target = dropTargetRef.current;
          const currentApi = apiRef.current;
          const sourcePanel = currentApi?.getPanel(sourcePanelId);
          let reorderGap: number | null = null;
          if (
            commit &&
            sourcePanel &&
            target?.kind === "header" &&
            currentApi?.groups.includes(target.group) &&
            target.targetTabId !== null
          ) {
            const current = latest.current;
            const sourceTab = current.tabs.find(
              (tab) => tab.id === sourceTabId,
            );
            const targetTab = current.tabs.find(
              (tab) => tab.id === target.targetTabId,
            );
            if (sourceTab && targetTab?.spaceId === sourceTab.spaceId) {
              reorderGap = calculateLinearReorderGap(
                current.tabs
                  .filter((tab) => tab.spaceId === sourceTab.spaceId)
                  .map((tab) => tab.id),
                sourceTabId,
                targetTab.id,
                target.placement,
              );
            }
          }

          if (
            commit &&
            sourcePanel &&
            target &&
            currentApi?.groups.includes(target.group)
          ) {
            applyingLayout.current = true;
            try {
              if (target.kind === "header") {
                sourcePanel.api.moveTo({
                  group: target.group,
                  position: "center",
                  index: target.index,
                });
              } else {
                sourcePanel.api.moveTo({
                  group: target.group,
                  position: target.zone,
                });
              }
            } finally {
              applyingLayout.current = false;
            }
            if (reorderGap !== null) {
              latest.current.onReorder(sourceTabId, reorderGap);
            }
          } else if (commit && !active && sourcePanel) {
            sourcePanel.api.setActive();
          }
        } finally {
          document.body.style.userSelect = previousUserSelect;
          if (active) {
            setNativeBrowserDragActive(false);
            suppressClickRef.current = true;
            setTimeout(() => {
              suppressClickRef.current = false;
            }, 0);
          }
          dropTargetRef.current = null;
          ghostElRef.current = null;
          setDragGhost(null);
          setDraggingTabId(null);
          setDropPreview(null);
        }
      };
      const move = (pointerEvent: PointerEvent) => {
        if (pointerEvent.pointerId !== pointerId) return;
        if (!active) {
          if (
            Math.hypot(
              pointerEvent.clientX - startX,
              pointerEvent.clientY - startY,
            ) < POINTER_DRAG_THRESHOLD
          ) {
            return;
          }
          active = true;
          setNativeBrowserDragActive(true);
          document.body.style.userSelect = "none";
          setDragGhost({
            label,
            width: dragRect.width,
            height: dragRect.height,
          });
          setDraggingTabId(sourceTabId);
        }
        pointerEvent.preventDefault();
        placeGhost(pointerEvent.clientX, pointerEvent.clientY);
        updateDropTarget(
          sourcePanelId,
          pointerEvent.clientX,
          pointerEvent.clientY,
        );
      };
      const up = (pointerEvent: PointerEvent) => {
        if (pointerEvent.pointerId !== pointerId) return;
        pointerEvent.preventDefault();
        pointerEvent.stopPropagation();
        if (active) {
          placeGhost(pointerEvent.clientX, pointerEvent.clientY);
          updateDropTarget(
            sourcePanelId,
            pointerEvent.clientX,
            pointerEvent.clientY,
          );
        }
        finish(true);
      };
      const cancel = (pointerEvent: PointerEvent) => {
        if (pointerEvent.pointerId === pointerId) finish(false);
      };
      const blur = () => finish(false);
      const visibilityChange = () => {
        if (document.visibilityState !== "visible") finish(false);
      };

      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", cancel);
      window.addEventListener("blur", blur);
      document.addEventListener("visibilitychange", visibilityChange);
      cleanupDragRef.current = () => finish(false);
    },
    [placeGhost, updateDropTarget],
  );

  const onClickCapture = useCallback((event: ReactMouseEvent) => {
    if (!suppressClickRef.current) return;
    suppressClickRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  useEffect(
    () => () => {
      cleanupDragRef.current?.();
      if (layoutSettledFrameRef.current) {
        cancelAnimationFrame(layoutSettledFrameRef.current);
      }
    },
    [],
  );

  // Save the outgoing space before replacing Dockview's complete grid state.
  useLayoutEffect(() => {
    if (!api || loadedSpaceRef.current === props.spaceId) return;

    cleanupDragRef.current?.();
    if (loadedSpaceRef.current !== null) {
      flushPersistedLayout(loadedSpaceRef.current, api);
    }
    loadedSpaceRef.current = props.spaceId;

    const current = latest.current;
    const tabIds = current.tabs.map((tab) => tab.id);
    loadedTabsRef.current = current.tabs;
    const fallback = workspaceTabsToDockviewLayout(
      tabIds,
      current.activeId,
      current.hideTabs ?? false,
    );
    const storage = workspaceLayoutStorage();
    const saved = storage
      ? readWorkspaceDockviewLayout(storage, props.spaceId, current.tabs)
      : null;

    applyingLayout.current = true;
    try {
      let restored = false;
      if (saved) {
        try {
          api.fromJSON(saved, { reuseExistingPanels: true });
          restored = true;
        } catch {
          // Structurally corrupt layouts are replaced by a known-good grid.
        }
      }
      if (!restored) {
        try {
          api.fromJSON(fallback, { reuseExistingPanels: true });
        } catch {
          // Keep the workspace mounted even if Dockview rejects its fallback.
        }
      }
      setGroupHeadersHidden(api, current.hideTabs ?? false);
    } finally {
      applyingLayout.current = false;
    }
    scheduleLayoutSettled();
  }, [api, props.spaceId, flushPersistedLayout, scheduleLayoutSettled]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: persistenceTabsKey deliberately tracks ref-backed tab snapshots.
  useEffect(() => {
    const current = latest.current;
    if (!api || loadedSpaceRef.current !== current.spaceId) return;
    loadedTabsRef.current = current.tabs;
    schedulePersistedLayout();
  }, [api, persistenceTabsKey, schedulePersistedLayout]);

  useEffect(() => {
    if (!api) return;
    setGroupHeadersHidden(api, props.hideTabs ?? false);
    const addedGroup = api.onDidAddGroup((group) => {
      group.header.hidden = latest.current.hideTabs ?? false;
    });
    return () => addedGroup.dispose();
  }, [api, props.hideTabs]);

  useEffect(() => {
    if (!api) return;
    const element = dockviewElementRef.current;
    if (!element) return;
    let frame = 0;
    const layout = () => {
      frame = 0;
      if (isWindowPresentationBlocked()) return;
      const width = element.clientWidth;
      const height = element.clientHeight;
      if (width < 2 || height < 2) return;
      api.layout(width, height, true);
    };
    const schedule = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(layout);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    const unsubscribe = subscribeWindowPresentation((next) => {
      if (next === "ready") layout();
    });
    layout();
    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
      unsubscribe();
    };
  }, [api]);

  useEffect(() => {
    if (!api) return;
    let disposed = false;
    let cleanupQueued = false;
    const cleanupEmptyGroups = () => {
      if (cleanupQueued) return;
      cleanupQueued = true;
      queueMicrotask(() => {
        cleanupQueued = false;
        if (disposed || applyingLayout.current) return;
        removeEmptyGroups(api);
      });
    };
    const changed = api.onDidLayoutChange(() => {
      schedulePersistedLayout();
      scheduleLayoutSettled();
      cleanupEmptyGroups();
    });
    cleanupEmptyGroups();
    return () => {
      disposed = true;
      changed.dispose();
      flushPersistedLayout(loadedSpaceRef.current, api);
    };
  }, [
    api,
    flushPersistedLayout,
    scheduleLayoutSettled,
    schedulePersistedLayout,
  ]);

  // Incremental model sync keeps group membership and split geometry intact.
  // biome-ignore lint/correctness/useExhaustiveDependencies: layoutKey deliberately reruns ref-driven incremental sync.
  useLayoutEffect(() => {
    if (!api || loadedSpaceRef.current !== props.spaceId) return;
    applyingLayout.current = true;
    try {
      const current = latest.current;
      loadedTabsRef.current = current.tabs;
      const wantedPanelIds = new Set(
        current.tabs.map((tab) => workspaceDockviewPanelId(tab.id)),
      );
      for (const panel of api.panels) {
        if (!wantedPanelIds.has(panel.id)) panel.api.close();
      }

      for (const [tabIndex, tab] of current.tabs.entries()) {
        const id = workspaceDockviewPanelId(tab.id);
        const existing = api.getPanel(id);
        if (existing) {
          if (existing.api.title !== labelFor(tab)) {
            existing.api.setTitle(labelFor(tab));
          }
          continue;
        }

        let neighbor = null;
        let neighborIndex = 0;
        for (let index = tabIndex - 1; index >= 0; index -= 1) {
          const panel = api.getPanel(
            workspaceDockviewPanelId(current.tabs[index].id),
          );
          if (!panel) continue;
          neighbor = panel;
          neighborIndex = panel.api.group.panels.indexOf(panel) + 1;
          break;
        }
        if (!neighbor) {
          for (
            let index = tabIndex + 1;
            index < current.tabs.length;
            index += 1
          ) {
            const panel = api.getPanel(
              workspaceDockviewPanelId(current.tabs[index].id),
            );
            if (!panel) continue;
            neighbor = panel;
            neighborIndex = panel.api.group.panels.indexOf(panel);
            break;
          }
        }

        const added = api.addPanel({
          id,
          component: WORKSPACE_DOCKVIEW_COMPONENT,
          title: labelFor(tab),
          params: { tabId: tab.id },
          inactive: true,
          position: workspaceDockviewInsertionPosition(
            api.activeGroup,
            neighbor,
            neighborIndex,
          ),
        });
        added.api.group.header.hidden = current.hideTabs ?? false;
      }

      const rank = new Map(
        current.tabs.map((tab, index) => [
          workspaceDockviewPanelId(tab.id),
          index,
        ]),
      );
      for (const group of api.groups) {
        const desired = [...group.panels].sort(
          (left, right) =>
            (rank.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
            (rank.get(right.id) ?? Number.MAX_SAFE_INTEGER),
        );
        for (const [index, panel] of desired.entries()) {
          if (group.panels[index] === panel) continue;
          panel.api.moveTo({ group, position: "center", index });
        }
        group.header.hidden = current.hideTabs ?? false;
      }
      const activePanel = api.getPanel(
        workspaceDockviewPanelId(current.activeId),
      );
      if (activePanel && api.activePanel !== activePanel) {
        activePanel.api.setActive();
      }
    } finally {
      applyingLayout.current = false;
    }
    scheduleLayoutSettled();
  }, [api, layoutKey, scheduleLayoutSettled, syncRevision]);

  useEffect(() => {
    if (!api) return;
    const currentTabIds = new Set(props.tabs.map((tab) => tab.id));
    const handledRevision =
      handledExternalSplits.current.get(props.spaceId) ?? 0;
    const pending = (props.externalSplits ?? [])
      .filter(
        (split) =>
          split.spaceId === props.spaceId && split.revision > handledRevision,
      )
      .sort((left, right) => left.revision - right.revision);
    let moved = false;
    for (const split of pending) {
      handledExternalSplits.current.set(props.spaceId, split.revision);
      if (
        !currentTabIds.has(split.tabId) ||
        !currentTabIds.has(split.referenceTabId)
      ) {
        continue;
      }
      const panel = api.getPanel(workspaceDockviewPanelId(split.tabId));
      const reference = api.getPanel(
        workspaceDockviewPanelId(split.referenceTabId),
      );
      if (!panel || !reference || panel === reference) continue;

      applyingLayout.current = true;
      try {
        panel.api.moveTo({
          group: reference.api.group,
          position: split.position,
        });
        moved = true;
      } finally {
        applyingLayout.current = false;
      }
    }
    if (moved) {
      schedulePersistedLayout();
      scheduleLayoutSettled();
    }
  }, [
    api,
    props.externalSplits,
    props.spaceId,
    props.tabs,
    scheduleLayoutSettled,
    schedulePersistedLayout,
  ]);

  useEffect(() => {
    if (!api) return;
    const currentTabIds = new Set(props.tabs.map((tab) => tab.id));
    const handledRevision =
      handledExternalMoves.current.get(props.spaceId) ?? 0;
    const pending = (props.externalMoves ?? [])
      .filter(
        (move) =>
          move.spaceId === props.spaceId && move.revision > handledRevision,
      )
      .sort((left, right) => left.revision - right.revision);
    let moved = false;
    for (const move of pending) {
      handledExternalMoves.current.set(props.spaceId, move.revision);
      if (
        !currentTabIds.has(move.tabId) ||
        !currentTabIds.has(move.targetTabId)
      ) {
        continue;
      }
      const source = api.getPanel(workspaceDockviewPanelId(move.tabId));
      const target = api.getPanel(workspaceDockviewPanelId(move.targetTabId));
      if (!source || !target) continue;

      const group = target.api.group;
      const sourceIndex = group.panels.indexOf(source);
      const targetIndex = group.panels.indexOf(target);
      let index = targetIndex + (move.placement === "after" ? 1 : 0);
      if (sourceIndex >= 0 && index > sourceIndex) index -= 1;
      if (source.api.group === group && sourceIndex === index) continue;
      applyingLayout.current = true;
      try {
        source.api.moveTo({ group, position: "center", index });
        moved = true;
      } finally {
        applyingLayout.current = false;
      }
    }
    if (moved) {
      schedulePersistedLayout();
      scheduleLayoutSettled();
    }
  }, [
    api,
    props.externalMoves,
    props.spaceId,
    props.tabs,
    scheduleLayoutSettled,
    schedulePersistedLayout,
  ]);

  useLayoutEffect(() => {
    if (!api) return;
    const panel = api.getPanel(workspaceDockviewPanelId(props.activeId));
    if (panel) {
      if (api.activePanel !== panel) panel.api.setActive();
      if (panel.group && api.activeGroup !== panel.group) {
        panel.group.focus();
      }
    }
  }, [api, props.activeId]);

  useEffect(() => {
    if (!api) return;
    let disposed = false;
    const pendingRemovals = new Set<string>();
    const activePanel = api.onDidActivePanelChange((panel) => {
      if (applyingLayout.current || !panel) return;
      const tabId = tabIdForParams(panel.params ?? {});
      const current = latest.current;
      if (tabId !== null && tabId !== current.activeId) current.onSelect(tabId);
    });
    const removedPanel = api.onDidRemovePanel((panel) => {
      if (applyingLayout.current || pendingRemovals.has(panel.id)) return;
      pendingRemovals.add(panel.id);
      queueMicrotask(() => {
        pendingRemovals.delete(panel.id);
        if (disposed || applyingLayout.current || api.getPanel(panel.id))
          return;
        const tabId = tabIdForParams(panel.params ?? {});
        if (
          tabId !== null &&
          latest.current.tabs.some((tab) => tab.id === tabId)
        ) {
          setSyncRevision((revision) => revision + 1);
        }
      });
    });
    return () => {
      disposed = true;
      activePanel.dispose();
      removedPanel.dispose();
    };
  }, [api]);

  const onReady = (event: DockviewReadyEvent) => {
    apiRef.current = event.api;
    setApi(event.api);
  };
  const contextValue: WorkspaceDockviewContextValue = {
    ...props,
    draggingTabId,
    onTabPointerDown,
  };
  const draggedTab = props.tabs.find((tab) => tab.id === draggingTabId);

  return (
    <WorkspaceDockviewContext.Provider value={contextValue}>
      <div className="anbo-workspace-dockview" onClickCapture={onClickCapture}>
        <DockviewReact
          ref={dockviewElementRef}
          components={components}
          defaultTabComponent={WorkspaceDockviewTab}
          rightHeaderActionsComponent={WorkspaceDockviewActions}
          disableDnd
          disableFloatingGroups
          disableAutoResizing
          noPanelsOverlay="emptyGroup"
          scrollbars="native"
          theme={workspaceTheme}
          onReady={onReady}
        />
        {(dropPreview || dragGhost) &&
          createPortal(
            <>
              {dropPreview ? (
                <div
                  aria-hidden
                  className={cn(
                    "anbo-workspace-dockview-drop-preview",
                    dropPreview.kind === "header" &&
                      "anbo-workspace-dockview-drop-preview-header",
                  )}
                  style={{
                    left: dropPreview.left,
                    top: dropPreview.top,
                    width: dropPreview.width,
                    height: dropPreview.height,
                  }}
                />
              ) : null}
              {dragGhost ? (
                <div
                  ref={ghostRef}
                  aria-hidden
                  className="anbo-workspace-dockview-drag-ghost"
                  style={{ width: dragGhost.width, height: dragGhost.height }}
                >
                  {draggedTab ? <TabIcon tab={draggedTab} /> : null}
                  <span>{dragGhost.label}</span>
                </div>
              ) : null}
            </>,
            document.body,
          )}
      </div>
    </WorkspaceDockviewContext.Provider>
  );
}
