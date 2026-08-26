import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  consumeLaunchFiles,
  getLaunchDir,
  hasExplicitLaunchDir,
} from "@/lib/launchDir";
import { quoteShellArg } from "@/lib/shellQuote";
import { usePresence } from "@/lib/usePresence";
import { useZoom } from "@/lib/useZoom";
import { isMarkdownPath } from "@/lib/utils";
import {
  type AgentLaunchRequest,
  AgentNotificationsBridge,
  buildAgentLaunchCommand,
  buildAgentRestoreCommand,
  canLaunchAgentRequest,
  collectAgentResumeLeaves,
  configuredAgentLaunchRequest,
  createAgentResumeStates,
  createManualAgentResumeState,
  findAgentLauncher,
  isMcpAgentId,
  MAX_PARALLEL_OPENCODE_AGENTS,
  nextAttentionTarget,
  pollCodexSession,
  validateAgentLaunchCommand,
  withAgentMcpRuntime,
} from "@/modules/agents";
import { setAgentRequestHandler } from "@/modules/agents/lib/agentAutomationBridge";
import { AGENT_RESPONSE_EVENT } from "@/modules/agents/lib/agentAutomationProtocol";
import { agentIdFor } from "@/modules/agents/lib/agentIdentity";
import { useAgentStore } from "@/modules/agents/store/agentStore";
import {
  AgentRunBridge,
  AiMiniWindow,
  LocalAgentNotificationsBridge,
  SelectionAskAi,
  useAiBootstrap,
  useAiLiveBridge,
  useChatStore,
  useSelectionAskAi,
} from "@/modules/ai";
import { AiComposerProvider } from "@/modules/ai/lib/composer";
import { native } from "@/modules/ai/lib/native";
import {
  BROWSER_CLOSE_RESPONSE_EVENT,
  BROWSER_OPEN_RESPONSE_EVENT,
  BROWSER_TABS_RESPONSE_EVENT,
  type BrowserPaneHandle,
  BrowserStack,
  acceptBrowserPopupRequest,
  beginBrowserSession,
  browserEmbedClose,
  browserOpenPlacement,
  clearBrowserAutomationActivity,
  faviconUrlForPage,
  filePathToBrowserUrl,
  getBrowserAutomationActivity,
  markBrowserAutomationActivity,
  resolveBrowserCloseTarget,
  resolveBrowserOpenSpace,
  resolveBrowserPopupSpace,
  selectBackgroundBrowserTabs,
} from "@/modules/browser";
import {
  setBrowserCloseRequestHandler,
  setBrowserOpenRequestHandler,
  setBrowserPopupRequestHandler,
  setBrowserTabsRequestHandler,
} from "@/modules/browser/automationOpenBridge";
import { CommandPalette, createCommandItems } from "@/modules/command-palette";
import {
  type EditorPaneHandle,
  NewEditorDialog,
  useApplyEditorFontSize,
  useEditorFileSync,
} from "@/modules/editor";
import { FileExplorer, type FileExplorerHandle } from "@/modules/explorer";
import type { GitHistorySearchHandle } from "@/modules/git-history";
import {
  Header,
  type SearchInlineHandle,
  type SearchTarget,
} from "@/modules/header";
import { setLspNavigator } from "@/modules/lsp";
import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  type ShortcutHandlers,
  type ShortcutId,
  shouldDisablePaneSwapShortcut,
  useGlobalShortcuts,
} from "@/modules/shortcuts";
import {
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SidebarRail,
  useSidebarPanel,
} from "@/modules/sidebar";
import {
  SourceControlPanel,
  useSourceControlContext,
} from "@/modules/source-control";
import {
  authorizeWorkspaceRoot,
  flushSpacePersistenceNow,
  newSpaceDefaults,
  SpaceSwitcher,
  useSpacePersistence,
  useSpaces,
  useSpacesBoot,
} from "@/modules/spaces";
import { StatusBar } from "@/modules/statusbar";
import {
  TabSwitcherHud,
  useTabSwitcher,
  useTabs,
  useWindowTitle,
  useWorkspaceCwd,
  WorkspaceDockview,
} from "@/modules/tabs";
import { DEFAULT_SPACE_ID } from "@/modules/tabs/lib/useTabs";
import {
  clearFocusedTerminal,
  collectRetainedTerminalLeafIds,
  disposeSession,
  disposeSessionsOutside,
  findLeafCwd,
  hasLeaf,
  leafHasForegroundProcess,
  leafIds,
  navigateFocusedBlocks,
  type PaneBounds,
  ptyIdForLeaf,
  readTerminalBuffer,
  refitVisibleTerminalSlots,
  selectBackgroundTerminalTabs,
  type TerminalPaneHandle,
  TerminalStack,
  useAgentActivityStore,
  useTerminalFileDrop,
  writeToReadySession,
  writeToSession,
} from "@/modules/terminal";
import { ThemeProvider, useThemeFileEditing } from "@/modules/theme";
import { UpdaterDialog } from "@/modules/updater";
import { useWorkspaceEnvStore, type WorkspaceEnv } from "@/modules/workspace";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import type { SearchAddon } from "@xterm/addon-search";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { CloseDialogs } from "./components/CloseDialogs";
import { LandingPage } from "./components/LandingPage";
import {
  TOGGLE_BLOCK_INPUT_EVENT,
  WorkspaceInputBar,
} from "./components/WorkspaceInputBar";
import { WorkspaceSurface } from "./components/WorkspaceSurface";
import { WorkspaceWelcome } from "./components/WorkspaceWelcome";
import { useAppCloseGuard } from "./hooks/useAppCloseGuard";
import { useTabCloseGuards } from "./hooks/useTabCloseGuards";
import { useWorkspaceSwitcher } from "./hooks/useWorkspaceSwitcher";

async function discoverAgentSession({
  agent,
  cwd,
  sinceTs,
  claimed,
  workspace,
}: {
  agent: string;
  cwd: string;
  sinceTs: number;
  claimed: ReadonlySet<string>;
  workspace: WorkspaceEnv;
}): Promise<string | null> {
  return pollCodexSession(() =>
    invoke<string | null>("anbo_find_agent_session", {
      agent,
      cwd,
      sinceTs,
      claimed: [...claimed],
      workspace,
    }),
  );
}

type AgentLaunchTarget = {
  spaceId: string;
  root: string | null;
  cwd: string | undefined;
  workspace: WorkspaceEnv;
  activate: boolean;
};

export default function App() {
  useEffect(() => {
    void beginBrowserSession().catch(() => {});
  }, []);

  const {
    tabs,
    activeId,
    setActiveId,
    warmTab,
    allocId,
    replaceTabs,
    moveTabToSpace,
    reorderTab,
    reorderTabByGap,
    newTabInSpace,
    removeTabsForSpace,
    resetSpace,
    markBooted,
    setActiveSpaceForNewTabs,
    newTab,
    newBlockTab,
    newAgentTab,
    newAgentTabs,
    pinAgentResumeSession,
    deactivateAgentResume,
    rearmAgentResume,
    adoptAgentResume,
    replaceAgentResume,
    adoptAgentIdentity,
    newPrivateTab,
    openFileTab,
    pinTab,
    newBrowserTab,
    activeBrowserTabIds,
    setActiveBrowserTabId,
    newMarkdownTab,
    setMarkdownView,
    setOverrideLanguage,
    openAiDiffTab,
    closeAiDiffTab,
    openGitDiffTab,
    openCommitHistoryTab,
    openCommitFileDiffTab,
    closeTab,
    updateTab,
    selectByIndex,
    setLeafCwd,
    focusPane,
    focusNextPaneInTab,
    swapActivePaneInDirection,
    closePaneByLeaf,
    clearTabs,
  } = useTabs(getLaunchDir() ? { cwd: getLaunchDir() } : undefined);

  // Mirror `tabs` into a ref so callbacks scheduled with `setTimeout`
  // (e.g. cdInNewTab) read the latest pane state instead of a stale closure.
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const customCliAgents = usePreferencesStore((s) => s.customCliAgents);
  const agentMcpEnabled = usePreferencesStore((s) => s.agentMcpEnabled);

  const activeTerminalTab = useMemo(() => {
    const t = tabs.find((x) => x.id === activeId);
    return t && t.kind === "terminal" ? t : null;
  }, [tabs, activeId]);
  const activeLeafId = activeTerminalTab?.activeLeafId ?? null;

  const searchAddons = useRef<Map<number, SearchAddon>>(new Map());
  const [activeSearchAddon, setActiveSearchAddon] =
    useState<SearchAddon | null>(null);
  const searchInlineRef = useRef<SearchInlineHandle | null>(null);
  const terminalRefs = useRef<Map<number, TerminalPaneHandle>>(new Map());
  const pendingAgentTargetRef = useRef<{
    spaceId: string;
    tabId: number;
    leafId: number;
  } | null>(null);
  const focusAgentTerminal = useCallback((leafId: number) => {
    let attempts = 0;
    const focus = () => {
      const terminal = terminalRefs.current.get(leafId);
      if (terminal) {
        terminal.focus();
        return;
      }
      attempts += 1;
      if (attempts < 16) requestAnimationFrame(focus);
    };
    setTimeout(() => requestAnimationFrame(focus), 0);
  }, []);
  const editorRefs = useRef<Map<number, EditorPaneHandle>>(new Map());
  const browserRefs = useRef<Map<number, BrowserPaneHandle>>(new Map());
  const lastBrowserPopupRef = useRef<{
    key: string;
    at: number;
  } | null>(null);
  const [activeEditorHandle, setActiveEditorHandle] =
    useState<EditorPaneHandle | null>(null);
  const [gitHistoryHandle, setGitHistoryHandle] =
    useState<GitHistorySearchHandle | null>(null);
  const gitHistoryHandles = useRef(new Map<number, GitHistorySearchHandle>());
  const gitHistoryHandleCallbacks = useRef(
    new Map<number, (handle: GitHistorySearchHandle | null) => void>(),
  );
  const getGitHistoryHandleCallback = (tabId: number) => {
    let callback = gitHistoryHandleCallbacks.current.get(tabId);
    if (!callback) {
      callback = (handle) => {
        if (handle) gitHistoryHandles.current.set(tabId, handle);
        else gitHistoryHandles.current.delete(tabId);
        if (activeIdRef.current === tabId) setGitHistoryHandle(handle);
      };
      gitHistoryHandleCallbacks.current.set(tabId, callback);
    }
    return callback;
  };
  useEffect(() => {
    setGitHistoryHandle(gitHistoryHandles.current.get(activeId) ?? null);
  }, [activeId]);
  const { zoomIn, zoomOut, zoomReset } = useZoom();
  useApplyEditorFontSize();
  const terminalPathDropTarget = useTerminalFileDrop();
  const explorerRef = useRef<FileExplorerHandle>(null);

  // Drives session disposal off the pane tree, not React lifecycles —
  // split/unsplit re-mount components but the leaf is still live.
  const liveLeavesRef = useRef<Set<number>>(new Set());
  const liveBrowserIdsRef = useRef<Set<number>>(new Set());

  const workspaceEnv = useWorkspaceEnvStore((s) => s.env);
  const setWorkspaceEnv = useWorkspaceEnvStore((s) => s.setEnv);
  const { home, launchCwd, launchCwdResolved, adoptWorkspaceEnv } =
    useWorkspaceSwitcher({
      workspaceEnv,
      setWorkspaceEnv,
    });

  const activeSpaceId = useSpaces((s) => s.activeId);
  const spacesHydrated = useSpaces((s) => s.hydrated);
  const spacesCount = useSpaces((s) => s.spaces.length);
  const spaceEnvironments = useSpaces((s) => s.spaces);
  const showLanding = spacesHydrated && spacesCount === 0;
  const activeSpaceRoot = useSpaces(
    (s) => s.spaces.find((p) => p.id === s.activeId)?.root ?? null,
  );
  const activeSpaceName = useSpaces(
    (s) => s.spaces.find((p) => p.id === s.activeId)?.name ?? null,
  );
  const workspaceForSpace = useCallback(
    (spaceId: string) =>
      spaceEnvironments.find((space) => space.id === spaceId)?.env ??
      workspaceEnv,
    [spaceEnvironments, workspaceEnv],
  );
  const browserWorkspaceContext = useCallback(
    (spaceId: string) => {
      const space = spaceEnvironments.find(
        (candidate) => candidate.id === spaceId,
      );
      return {
        root: space?.root ?? null,
        workspace: space?.env ?? workspaceEnv,
      };
    },
    [spaceEnvironments, workspaceEnv],
  );
  const cleanedAgentHookRootsRef = useRef(new Set<string>());
  useEffect(() => {
    if (!spacesHydrated) return;
    for (const space of spaceEnvironments) {
      if (!space.root || cleanedAgentHookRootsRef.current.has(space.root)) {
        continue;
      }
      cleanedAgentHookRootsRef.current.add(space.root);
      void (async () => {
        for (let attempt = 0; attempt < 10; attempt += 1) {
          try {
            const removed = await invoke<number>("agent_cleanup_hooks", {
              workspaceRoot: space.root,
              workspace: space.env,
            });
            if (removed > 0) {
              console.info(
                `[anbo] removed ${removed} project agent hook integration(s) from ${space.root}`,
              );
            }
            return;
          } catch (error) {
            if (attempt === 9) {
              cleanedAgentHookRootsRef.current.delete(space.root ?? "");
              console.warn(
                "[anbo] could not remove project agent hooks:",
                error,
              );
              return;
            }
            await new Promise((resolve) => window.setTimeout(resolve, 300));
          }
        }
      })();
    }
  }, [spaceEnvironments, spacesHydrated]);
  // Welcome when the ACTIVE space has no tabs (not total tabs — other spaces may
  // have tabs). Closing the last terminal in a space → welcome for that space.
  const showWorkspaceWelcome =
    !showLanding &&
    !tabs.some((t) => t.spaceId === (activeSpaceId ?? DEFAULT_SPACE_ID));

  const handleWorkspaceChange = useCallback(
    async (env: WorkspaceEnv) => {
      const spaceId = useSpaces.getState().activeId;
      if (!spaceId) return;
      const affected = tabsRef.current.filter((tab) => tab.spaceId === spaceId);
      if (affected.some((tab) => tab.kind === "editor" && tab.dirty)) {
        window.alert(
          "Save or close unsaved editor tabs before switching workspace environment.",
        );
        return;
      }
      const leafIdsToCheck = affected.flatMap((tab) =>
        tab.kind === "terminal" ? leafIds(tab.paneTree) : [],
      );
      const busy = (
        await Promise.all(leafIdsToCheck.map(leafHasForegroundProcess))
      ).filter(Boolean).length;
      if (
        busy > 0 &&
        !window.confirm(
          `Switch environment? ${busy} running terminal process(es) in this workspace will be closed. Other workspaces will keep running.`,
        )
      ) {
        return;
      }
      if (useSpaces.getState().activeId !== spaceId) return;
      const nextHome = await adoptWorkspaceEnv(env);
      if (nextHome === null || useSpaces.getState().activeId !== spaceId)
        return;

      for (const tab of affected) {
        gitHistoryHandles.current.delete(tab.id);
        gitHistoryHandleCallbacks.current.delete(tab.id);
        if (tab.kind === "terminal") {
          for (const leafId of leafIds(tab.paneTree)) {
            liveLeavesRef.current.delete(leafId);
            searchAddons.current.delete(leafId);
            terminalRefs.current.delete(leafId);
          }
        } else if (tab.kind === "browser") {
          liveBrowserIdsRef.current.delete(tab.id);
          clearBrowserAutomationActivity(tab.id);
          await browserEmbedClose(tab.id).catch(() => {});
          browserRefs.current.delete(tab.id);
        } else if (tab.kind === "editor") {
          editorRefs.current.delete(tab.id);
        }
      }
      useSpaces.getState().setEnv(spaceId, env);
      resetSpace(spaceId, nextHome);
    },
    [adoptWorkspaceEnv, resetSpace],
  );

  useSpacesBoot({
    ready: launchCwdResolved,
    launchCwd,
    home,
    hasExplicitLaunchDir: hasExplicitLaunchDir(),
    allocId,
    replaceTabs,
    markBooted,
    setActiveSpaceForNewTabs,
    adoptWorkspaceEnv,
  });

  useSpacePersistence({
    tabs,
    activeId,
    activeSpaceId: activeSpaceId ?? DEFAULT_SPACE_ID,
    enabled: spacesHydrated && spacesCount > 0,
  });

  const prevSpaceRef = useRef(activeSpaceId);
  useEffect(() => {
    if (!spacesHydrated || !activeSpaceId) return;
    setActiveSpaceForNewTabs(activeSpaceId);
    const prev = prevSpaceRef.current;
    prevSpaceRef.current = activeSpaceId;
    if (prev === null || prev === activeSpaceId) return;
    const meta = useSpaces
      .getState()
      .spaces.find((space) => space.id === activeSpaceId);
    if (meta) void adoptWorkspaceEnv(meta.env);
    const pendingAgentTarget = pendingAgentTargetRef.current;
    if (pendingAgentTarget?.spaceId === activeSpaceId) {
      pendingAgentTargetRef.current = null;
      warmTab(pendingAgentTarget.tabId);
      focusPane(pendingAgentTarget.tabId, pendingAgentTarget.leafId);
      setActiveId(pendingAgentTarget.tabId);
      focusAgentTerminal(pendingAgentTarget.leafId);
      return;
    }
    const inSpace = tabsRef.current.filter((t) => t.spaceId === activeSpaceId);
    if (inSpace.length === 0) {
      setActiveId(-1);
      return;
    }
    // Keep the active tab if it already belongs to the newly active space (a
    // cross-space jump set it explicitly); else fall to the space's last tab.
    if (inSpace.some((t) => t.id === activeId)) return;
    setActiveId(inSpace[inSpace.length - 1].id);
  }, [
    activeSpaceId,
    activeId,
    spacesHydrated,
    setActiveSpaceForNewTabs,
    setActiveId,
    warmTab,
    focusPane,
    focusAgentTerminal,
    adoptWorkspaceEnv,
  ]);

  const [switcherOpen, setSwitcherOpen] = useState(false);
  const dockviewMoveRevision = useRef(0);
  const dockviewSplitRevision = useRef(0);
  const [dockviewExternalMoves, setDockviewExternalMoves] = useState<
    Array<{
      tabId: number;
      targetTabId: number;
      placement: "before" | "after";
      spaceId: string;
      revision: number;
    }>
  >([]);
  const [dockviewExternalSplits, setDockviewExternalSplits] = useState<
    Array<{
      tabId: number;
      referenceTabId: number;
      position: "right" | "bottom";
      spaceId: string;
      revision: number;
    }>
  >([]);

  const spaceTabs = useMemo(
    () => tabs.filter((t) => t.spaceId === (activeSpaceId ?? DEFAULT_SPACE_ID)),
    [tabs, activeSpaceId],
  );
  const [visibleDockviewTabIds, setVisibleDockviewTabIds] = useState<
    ReadonlySet<number>
  >(() => new Set());
  const handleDockviewTabVisibility = useCallback(
    (id: number, visible: boolean) => {
      setVisibleDockviewTabIds((current) => {
        if (current.has(id) === visible) return current;
        const next = new Set(current);
        if (visible) next.add(id);
        else next.delete(id);
        return next;
      });
    },
    [],
  );
  const backgroundBrowserTabs = useMemo(
    () => selectBackgroundBrowserTabs(tabs, visibleDockviewTabIds),
    [tabs, visibleDockviewTabIds],
  );
  const backgroundTerminalTabs = useMemo(
    () => selectBackgroundTerminalTabs(tabs, activeSpaceId ?? DEFAULT_SPACE_ID),
    [tabs, activeSpaceId],
  );

  const {
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
  } = useSidebarPanel(explorerRef);

  const [newEditorOpen, setNewEditorOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [paletteInitialMode, setPaletteInitialMode] = useState<
    "commands" | "content"
  >("commands");
  const openCommandPalette = useCallback(
    (mode: "commands" | "content" = "commands") => {
      setPaletteInitialMode(mode);
      setCommandPaletteOpen(true);
    },
    [],
  );
  const miniOpen = useChatStore((s) => s.mini.open);
  const miniPresence = usePresence(miniOpen, 200);
  const openMini = useChatStore((s) => s.openMini);
  const toggleMini = useChatStore((s) => s.toggleMini);
  const focusInput = useChatStore((s) => s.focusInput);
  const openPanel = useChatStore((s) => s.openPanel);
  const panelOpen = useChatStore((s) => s.panelOpen);
  const setLive = useChatStore((s) => s.setLive);
  const respondToApproval = useChatStore((s) => s.respondToApproval);

  const { hasComposer, keysLoaded } = useAiBootstrap();

  const activeTab = tabs.find((t) => t.id === activeId);
  const isTerminalTab = activeTab?.kind === "terminal";
  const isBlockTab = activeTerminalTab?.blocks === true;
  const isEditorTab = activeTab?.kind === "editor";
  const isGitHistoryTab = activeTab?.kind === "git-history";

  useEditorFileSync({ tabs, tabsRef, editorRefs, workspaceForSpace });
  useThemeFileEditing({ tabsRef, openFileTab });

  const { explorerRoot, inheritedCwdForNewTab } =
    useWorkspaceCwd(activeSpaceRoot);

  useWindowTitle(activeTab, explorerRoot);

  useEffect(() => {
    setActiveSearchAddon(
      activeLeafId !== null
        ? (searchAddons.current.get(activeLeafId) ?? null)
        : null,
    );
    setActiveEditorHandle(editorRefs.current.get(activeId) ?? null);
  }, [activeId, activeLeafId]);

  const handleSearchReady = useCallback(
    (leafId: number, addon: SearchAddon) => {
      searchAddons.current.set(leafId, addon);
      if (leafId === activeLeafId) setActiveSearchAddon(addon);
    },
    [activeLeafId],
  );

  const disposeTab = useCallback(
    (id: number) => {
      // Terminal-leaf-keyed maps (terminalRefs/searchAddons) are pruned by
      // the effect below as the pane tree changes; only the tab-id-keyed
      // handles need explicit cleanup here.
      editorRefs.current.delete(id);
      browserRefs.current.delete(id);
      closeTab(id);
    },
    [closeTab],
  );

  const {
    pendingCloseTab,
    pendingTerminalCloseTab,
    pendingTerminalCloseLeaf,
    pendingDeleteTabs,
    handleClose,
    handleClosePane,
    confirmClose,
    cancelClose,
    confirmTerminalClose,
    cancelTerminalClose,
    confirmDeleteClose,
    cancelDeleteClose,
    handlePathDeleted,
  } = useTabCloseGuards({ tabs, disposeTab, disposePane: closePaneByLeaf });

  const { pendingAppClose, confirmAppClose, cancelAppClose } = useAppCloseGuard(
    tabsRef,
    flushSpacePersistenceNow,
  );

  useEffect(() => {
    const live = collectRetainedTerminalLeafIds(tabs);
    disposeSessionsOutside(live);
    for (const id of liveLeavesRef.current) {
      if (!live.has(id)) disposeSession(id);
    }
    liveLeavesRef.current = live;
    for (const k of [...terminalRefs.current.keys()])
      if (!live.has(k)) terminalRefs.current.delete(k);
    for (const k of [...searchAddons.current.keys()])
      if (!live.has(k)) searchAddons.current.delete(k);

    const liveBrowsers = new Set(
      tabs.filter((tab) => tab.kind === "browser").map((tab) => tab.id),
    );
    for (const id of liveBrowserIdsRef.current) {
      if (!liveBrowsers.has(id)) {
        clearBrowserAutomationActivity(id);
        void browserEmbedClose(id).catch(() => {});
      }
    }
    liveBrowserIdsRef.current = liveBrowsers;
  }, [tabs]);

  useEffect(() => {
    const tab = tabsRef.current.find((t) => t.id === activeId);
    if (tab?.kind !== "terminal") return;
    const ptyIds = leafIds(tab.paneTree).flatMap((leafId) => {
      const ptyId = ptyIdForLeaf(leafId);
      return ptyId === null ? [] : [ptyId];
    });
    useAgentActivityStore.getState().acknowledgeAttention(ptyIds);
  }, [activeId]);

  // Most-recently-used tab ids, most recent first, pruned to live tabs. Drives
  // the Ctrl+Tab quick switcher so it cycles by recency, not strip order.
  const mruRef = useRef<number[]>([activeId]);
  useEffect(() => {
    mruRef.current = [
      activeId,
      ...mruRef.current.filter((id) => id !== activeId),
    ];
  }, [activeId]);
  useEffect(() => {
    const live = new Set(tabs.map((t) => t.id));
    mruRef.current = mruRef.current.filter((id) => live.has(id));
  }, [tabs]);

  const getSwitcherOrder = useCallback(() => {
    const space = activeSpaceId ?? DEFAULT_SPACE_ID;
    const inSpace = tabsRef.current
      .filter((t) => t.spaceId === space)
      .map((t) => t.id);
    const present = new Set(inSpace);
    const ordered = mruRef.current.filter((id) => present.has(id));
    for (const id of inSpace) if (!ordered.includes(id)) ordered.push(id);
    return [activeId, ...ordered.filter((id) => id !== activeId)];
  }, [activeId, activeSpaceId]);

  const { state: switcherState, step: stepSwitcher } = useTabSwitcher({
    getOrder: getSwitcherOrder,
    onCommit: (id) => {
      if (tabsRef.current.some((t) => t.id === id)) setActiveId(id);
    },
  });

  const cycleSpace = useCallback((delta: 1 | -1) => {
    const { spaces, activeId: sid, setActive } = useSpaces.getState();
    if (spaces.length < 2) return;
    const idx = spaces.findIndex((s) => s.id === sid);
    const next = (idx + delta + spaces.length) % spaces.length;
    setActive(spaces[next].id);
  }, []);

  const captureActiveSelection = useCallback((): string | null => {
    const t = tabs.find((x) => x.id === activeId);
    if (!t) return null;
    if (t.kind === "terminal") {
      const lid = t.activeLeafId;
      return terminalRefs.current.get(lid)?.getSelection() ?? null;
    }
    if (t.kind === "editor") {
      return editorRefs.current.get(activeId)?.getSelection() ?? null;
    }
    return null;
  }, [tabs, activeId]);

  const togglePanelAndFocus = useCallback(() => {
    if (!hasComposer) {
      void openSettingsWindow("models");
      return;
    }
    if (panelOpen) {
      useChatStore.getState().closePanel();
    } else {
      openPanel();
      focusInput(null);
    }
  }, [hasComposer, panelOpen, openPanel, focusInput]);

  const attachSelection = useChatStore((s) => s.attachSelection);

  const handleAttachFileToAgent = useCallback(
    (path: string) => {
      if (!hasComposer) {
        void openSettingsWindow("models");
        return;
      }
      // Dispatch a window event the composer listens for. Same pattern as
      // selections — keeps file-explorer decoupled from the AI module.
      window.dispatchEvent(
        new CustomEvent<string>("anbo:ai-attach-file", { detail: path }),
      );
      openPanel();
      focusInput(null);
    },
    [hasComposer, openPanel, focusInput],
  );

  const askFromSelection = useCallback(() => {
    if (!hasComposer) {
      void openSettingsWindow("models");
      return;
    }
    const selection = captureActiveSelection();
    if (!selection || !selection.trim()) {
      focusInput(null);
      return;
    }
    const source: "terminal" | "editor" =
      activeTab?.kind === "editor" ? "editor" : "terminal";
    attachSelection(selection, source);
  }, [
    hasComposer,
    captureActiveSelection,
    focusInput,
    attachSelection,
    activeTab,
  ]);

  const { askPopup, setAskPopup, onAskFromSelection } = useSelectionAskAi({
    captureActiveSelection,
    askFromSelection,
  });
  const askPresence = usePresence(Boolean(askPopup), 120);

  const openNewTab = useCallback(() => {
    newTab(inheritedCwdForNewTab());
  }, [newTab, inheritedCwdForNewTab]);

  const openNewPrivateTab = useCallback(() => {
    newPrivateTab(inheritedCwdForNewTab());
  }, [newPrivateTab, inheritedCwdForNewTab]);

  const openNewBlockTab = useCallback(() => {
    newBlockTab(inheritedCwdForNewTab());
  }, [newBlockTab, inheritedCwdForNewTab]);

  const resumedAgentLeavesRef = useRef(new Set<number>());
  const agentDiscoveryLeavesRef = useRef(new Set<number>());
  const requestedAgentDiscoveryLeavesRef = useRef(new Set<number>());
  const agentDiscoveryGenerationRef = useRef(new Map<number, number>());
  const agentRecoveryRunningRef = useRef(false);
  const [agentDiscoveryRetry, setAgentDiscoveryRetry] = useState(0);
  const handleAgentStarted = useCallback(
    (leafId: number, agent: string, sessionId?: string) => {
      const target = tabsRef.current.find(
        (tab) =>
          tab.kind === "terminal" &&
          !tab.private &&
          hasLeaf(tab.paneTree, leafId),
      );
      if (target?.kind !== "terminal") return;
      const existing = tabsRef.current
        .filter((tab) => tab.kind === "terminal")
        .flatMap((tab) => collectAgentResumeLeaves(tab.paneTree))
        .find((leaf) => leaf.id === leafId);
      const discoveryStartedAt = Math.max(0, Date.now() - 2_000);
      const manualResume = createManualAgentResumeState(
        agent,
        discoveryStartedAt,
      );
      if (!manualResume) return;
      const changesAgentFamily =
        (existing !== undefined && existing.resume.agent !== agent) ||
        (target.agent !== undefined && target.agent.launcherId !== agent);
      if (changesAgentFamily) {
        resumedAgentLeavesRef.current.delete(leafId);
        requestedAgentDiscoveryLeavesRef.current.delete(leafId);
      }
      if (manualResume) {
        const launcher = findAgentLauncher(manualResume.agent);
        if (launcher) {
          adoptAgentIdentity(leafId, {
            launcherId: launcher.id,
            icon: launcher.icon,
            label: launcher.label,
          });
        }
      }
      const restoringFreshAgent =
        resumedAgentLeavesRef.current.has(leafId) &&
        existing?.resume.sessionId === undefined;
      if (
        resumedAgentLeavesRef.current.has(leafId) &&
        !restoringFreshAgent
      ) {
        return;
      }
      if (restoringFreshAgent) {
        resumedAgentLeavesRef.current.delete(leafId);
      }
      const generation =
        (agentDiscoveryGenerationRef.current.get(leafId) ?? 0) + 1;
      agentDiscoveryGenerationRef.current.set(leafId, generation);
      if (existing?.resume.agent === agent) {
        rearmAgentResume(leafId, agent, discoveryStartedAt);
      } else if (changesAgentFamily) {
        replaceAgentResume(leafId, manualResume);
      } else {
        adoptAgentResume(leafId, manualResume);
      }
      if (sessionId) {
        pinAgentResumeSession(leafId, sessionId);
        requestedAgentDiscoveryLeavesRef.current.delete(leafId);
        return;
      }
      requestedAgentDiscoveryLeavesRef.current.add(leafId);
      setAgentDiscoveryRetry((value) => value + 1);
    },
    [
      adoptAgentIdentity,
      adoptAgentResume,
      pinAgentResumeSession,
      rearmAgentResume,
      replaceAgentResume,
    ],
  );
  const handleAgentSettled = useCallback((leafId: number) => {
    requestedAgentDiscoveryLeavesRef.current.add(leafId);
    setAgentDiscoveryRetry((value) => value + 1);
  }, []);
  const handleAgentExited = useCallback(
    (leafId: number) => {
      resumedAgentLeavesRef.current.delete(leafId);
      requestedAgentDiscoveryLeavesRef.current.delete(leafId);
      agentDiscoveryGenerationRef.current.set(
        leafId,
        (agentDiscoveryGenerationRef.current.get(leafId) ?? 0) + 1,
      );
      deactivateAgentResume(leafId);
    },
    [deactivateAgentResume],
  );
  useEffect(() => {
    const mcpPromises = new Map<string, Promise<boolean>>();
    let resumeDelay = 0;
    for (const tab of tabs) {
      if (tab.kind !== "terminal") continue;
      const agentLeaves = collectAgentResumeLeaves(tab.paneTree);
      if (!agentLeaves.some(({ resume }) => resume.resumeOnStart)) continue;
      if (tab.cold) {
        warmTab(tab.id);
        continue;
      }
      const space = spaceEnvironments.find(
        (candidate) => candidate.id === tab.spaceId,
      );
      if (!space) continue;
      const targetRoot = space.root;
      const targetWorkspace = space.env;
      for (const leaf of agentLeaves) {
        if (
          !leaf.resume.resumeOnStart ||
          resumedAgentLeavesRef.current.has(leaf.id)
        ) {
          continue;
        }
        if (
          leaf.resume.agent === "opencode" &&
          targetWorkspace.kind !== "local"
        ) {
          continue;
        }
        const baseResumeCommand = buildAgentRestoreCommand(leaf.resume);
        if (!baseResumeCommand) continue;
        let mcpReady = Promise.resolve(false);
        if (isMcpAgentId(leaf.resume.agent) && targetRoot) {
          const key = `${tab.spaceId}:${leaf.resume.agent}`;
          const existing = mcpPromises.get(key);
          if (existing) {
            mcpReady = existing;
          } else {
            const enabled = agentMcpEnabled[leaf.resume.agent];
            mcpReady = invoke("agent_configure_mcp", {
              agent: leaf.resume.agent,
              workspaceRoot: targetRoot,
              workspace: targetWorkspace,
              enabled,
            })
              .then(() => enabled)
              .catch((error) => {
                console.warn(
                  `[anbo] could not configure ${leaf.resume.agent} MCP before resume:`,
                  error,
                );
                toast.error("Anbo MCP setup failed", {
                  description: `${leaf.resume.agent}: ${String(error)}`,
                });
                return false;
              });
            mcpPromises.set(key, mcpReady);
          }
        }
        resumedAgentLeavesRef.current.add(leaf.id);
        const delay = resumeDelay;
        resumeDelay += 4_000;
        void (async () => {
          if (delay > 0) {
            await new Promise<void>((resolve) => setTimeout(resolve, delay));
          }
          const mcpConfigured = await mcpReady;
          const resumeCommand = mcpConfigured
            ? withAgentMcpRuntime(
                leaf.resume.agent,
                baseResumeCommand,
                targetRoot ?? "",
                targetWorkspace.kind === "local",
              )
            : baseResumeCommand;
          if (!(await writeToReadySession(leaf.id, `${resumeCommand}\r`))) {
            resumedAgentLeavesRef.current.delete(leaf.id);
            console.error(
              `[anbo] agent terminal ${leaf.id} closed before resume`,
            );
          }
        })();
      }
    }
  }, [agentMcpEnabled, spaceEnvironments, tabs, warmTab]);

  useEffect(() => {
    if (agentRecoveryRunningRef.current) return;
    const pending = tabs
      .flatMap((tab) => {
        if (tab.kind !== "terminal" || tab.cold) return [];
        const space = spaceEnvironments.find(
          (candidate) => candidate.id === tab.spaceId,
        );
        if (!space?.root || space.env.kind !== "local") return [];
        return collectAgentResumeLeaves(tab.paneTree).map((leaf) => ({
          leaf,
          root: space.root as string,
          workspace: space.env,
          generation: agentDiscoveryGenerationRef.current.get(leaf.id) ?? 0,
        }));
      })
      .filter(
        ({ leaf }) =>
          !leaf.resume.sessionId &&
          leaf.resume.armed === false &&
          requestedAgentDiscoveryLeavesRef.current.has(leaf.id) &&
          !agentDiscoveryLeavesRef.current.has(leaf.id),
      );
    if (pending.length === 0) return;
    const recoverable = pending.filter(
      ({ leaf }) => leaf.resume.discoveryStartedAt !== undefined,
    );
    if (recoverable.length === 0) return;

    agentRecoveryRunningRef.current = true;
    void (async () => {
      try {
        const claimedByAgent = new Map<string, Set<string>>();
        for (const tab of tabsRef.current) {
          if (tab.kind !== "terminal") continue;
          for (const leaf of collectAgentResumeLeaves(tab.paneTree)) {
            if (!leaf.resume.sessionId) continue;
            const claimed =
              claimedByAgent.get(leaf.resume.agent) ?? new Set<string>();
            claimed.add(leaf.resume.sessionId);
            claimedByAgent.set(leaf.resume.agent, claimed);
          }
        }
        for (const { leaf, root, workspace, generation } of recoverable) {
          agentDiscoveryLeavesRef.current.add(leaf.id);
          try {
            const claimed =
              claimedByAgent.get(leaf.resume.agent) ?? new Set<string>();
            const sessionId = await discoverAgentSession({
              agent: leaf.resume.agent,
              cwd: leaf.cwd ?? root,
              sinceTs: leaf.resume.discoveryStartedAt ?? 0,
              claimed,
              workspace,
            });
            if (
              sessionId &&
              agentDiscoveryGenerationRef.current.get(leaf.id) === generation
            ) {
              claimed.add(sessionId);
              claimedByAgent.set(leaf.resume.agent, claimed);
              pinAgentResumeSession(leaf.id, sessionId);
              requestedAgentDiscoveryLeavesRef.current.delete(leaf.id);
            }
          } catch (error) {
            console.warn(
              `[anbo] could not recover ${leaf.resume.agent} session for terminal ${leaf.id} on attempt ${agentDiscoveryRetry + 1}:`,
              error,
            );
          } finally {
            agentDiscoveryLeavesRef.current.delete(leaf.id);
          }
        }
      } finally {
        agentRecoveryRunningRef.current = false;
      }
    })();
  }, [agentDiscoveryRetry, pinAgentResumeSession, spaceEnvironments, tabs]);

  const launchAgentGroupAt = useCallback(
    (request: AgentLaunchRequest, target: AgentLaunchTarget) => {
      const command = validateAgentLaunchCommand(request.command);
      if (!command.ok) return null;
      const launcher = findAgentLauncher(request.agent, customCliAgents);
      if (!launcher) return null;
      const runningAgents = Object.values(
        useAgentActivityStore.getState().agents,
      );
      if (!canLaunchAgentRequest(request, runningAgents)) {
        toast.error("OpenCode launch blocked", {
          description: `Anbo limits OpenCode to ${MAX_PARALLEL_OPENCODE_AGENTS} concurrent instances to prevent WebView out-of-memory crashes. Close one before starting another.`,
        });
        return null;
      }
      const agentCwd = target.cwd;
      const agentResumes =
        request.agent === "opencode" && target.workspace.kind !== "local"
          ? Array.from({ length: request.instances }, () => undefined)
          : createAgentResumeStates(
              request.agent,
              command.command,
              request.instances,
            );
      const { tabIds, leafIds: agentLeafIds } = newAgentTabs(
        agentCwd,
        {
          launcherId: launcher.id,
          icon: launcher.icon,
          label: launcher.label,
        },
        request.instances,
        agentResumes,
        { spaceId: target.spaceId, activate: target.activate },
      );
      const targetWorkspace = target.workspace;
      const mcpEnabled =
        isMcpAgentId(request.agent) && agentMcpEnabled[request.agent];
      const mcpReady =
        isMcpAgentId(request.agent) && target.root
          ? invoke("agent_configure_mcp", {
              agent: request.agent,
              workspaceRoot: target.root,
              workspace: targetWorkspace,
              enabled: mcpEnabled,
            })
              .then(() => mcpEnabled)
              .catch((error) => {
                console.warn(
                  `[anbo] could not configure ${request.agent} MCP:`,
                  error,
                );
                toast.error("Anbo MCP setup failed", {
                  description: `${request.agent}: ${String(error)}`,
                });
                return false;
              })
          : Promise.resolve(false);

      const launch = async () => {
        const mcpConfigured = await mcpReady;
        const launchOne = async (leafId: number, index: number) => {
          const resume = agentResumes[index];
          const baseLaunchCommand = buildAgentLaunchCommand(
            resume,
            command.command,
          );
          const launchCommand =
            mcpConfigured && target.root
              ? withAgentMcpRuntime(
                  request.agent,
                  baseLaunchCommand,
                  target.root,
                  targetWorkspace.kind === "local",
                )
              : baseLaunchCommand;
          if (!(await writeToReadySession(leafId, `${launchCommand}\r`))) {
            console.error(
              `[anbo] agent terminal ${leafId} closed before launch`,
            );
          }
        };

        await Promise.all(
          agentLeafIds.map((leafId, index) => launchOne(leafId, index)),
        );
      };
      void launch();
      return { tabIds, leafIds: agentLeafIds };
    },
    [agentMcpEnabled, customCliAgents, newAgentTabs],
  );

  const launchAgentGroup = useCallback(
    (request: AgentLaunchRequest) => {
      launchAgentGroupAt(request, {
        spaceId: activeSpaceId ?? DEFAULT_SPACE_ID,
        root: activeSpaceRoot,
        cwd: inheritedCwdForNewTab(),
        workspace: workspaceForSpace(activeSpaceId ?? DEFAULT_SPACE_ID),
        activate: true,
      });
    },
    [
      activeSpaceId,
      activeSpaceRoot,
      inheritedCwdForNewTab,
      launchAgentGroupAt,
      workspaceForSpace,
    ],
  );

  const launchAgentGroupAtRef = useRef(launchAgentGroupAt);
  launchAgentGroupAtRef.current = launchAgentGroupAt;

  const sendCd = useCallback(
    (path: string) => {
      if (activeLeafId === null) return;
      const term = terminalRefs.current.get(activeLeafId);
      if (!term) return;
      term.write(`cd ${quoteShellArg(path)}\r`);
      term.focus();
    },
    [activeLeafId],
  );

  const cdInNewTab = useCallback(
    (path: string) => {
      const tabId = newTab(path);
      setTimeout(() => {
        const tab = tabsRef.current.find((x) => x.id === tabId);
        if (!tab || tab.kind !== "terminal") return;
        const t = terminalRefs.current.get(tab.activeLeafId);
        if (!t) return;
        t.write(`cd ${quoteShellArg(path)}\r`);
        t.focus();
      }, 80);
    },
    [newTab],
  );

  const handleOpenFile = useCallback(
    (path: string, pin?: boolean) => {
      // Markdown opens in its rendered view by default; a per-tab toggle flips
      // it to the raw editor. Other files default to preview (pin=false);
      // explicit actions like context-menu "Open" pass pin=true to persist.
      if (isMarkdownPath(path)) newMarkdownTab(path);
      else openFileTab(path, pin ?? false);
    },
    [openFileTab, newMarkdownTab],
  );

  // "Open With" files arrive via the event (warm start) and get_launch_files
  // (cold start, before this listener attaches). Backend already authorized
  // each parent; openFileTab dedupes by path, so both paths can't double-open.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    const openAll = (paths: string[]) => {
      for (const path of paths) handleOpenFile(path, true);
    };
    (async () => {
      unlisten = await listen<string[]>("anbo:open-file", (e) => {
        openAll(e.payload);
      });
      openAll(await consumeLaunchFiles());
    })();
    return () => unlisten?.();
  }, [handleOpenFile]);

  const handlePathRenamed = useCallback(
    (from: string, to: string) => {
      for (const t of tabs) {
        if (t.kind !== "editor") continue;
        if (t.path === from) {
          const i = to.lastIndexOf("/");
          updateTab(t.id, { path: to, title: i === -1 ? to : to.slice(i + 1) });
        } else if (t.path.startsWith(`${from}/`)) {
          const suffix = t.path.slice(from.length);
          const newPath = `${to}${suffix}`;
          const i = newPath.lastIndexOf("/");
          updateTab(t.id, {
            path: newPath,
            title: i === -1 ? newPath : newPath.slice(i + 1),
          });
        }
      }
    },
    [tabs, updateTab],
  );

  const activeTerminalLeafCwd =
    activeTab?.kind === "terminal"
      ? (findLeafCwd(activeTab.paneTree, activeTab.activeLeafId) ??
        activeTab.cwd ??
        null)
      : null;

  const activeFilePath = (() => {
    if (activeTab?.kind === "editor") return activeTab.path;
    if (activeTab?.kind === "git-diff") {
      if (/^([A-Za-z]:|\/|\\)/.test(activeTab.path)) return activeTab.path;
      const root = activeTab.repoRoot.replace(/[\\/]+$/, "");
      const rel = activeTab.path.replace(/^[\\/]+/, "");
      return `${root}/${rel}`;
    }
    if (activeTab?.kind === "git-commit-file") {
      const root = activeTab.repoRoot.replace(/[\\/]+$/, "");
      const rel = activeTab.path.replace(/^[\\/]+/, "");
      return `${root}/${rel}`;
    }
    return null;
  })();
  const explorerActiveFilePath =
    activeTab?.kind === "editor" || activeTab?.kind === "markdown"
      ? activeTab.path
      : null;
  const { sourceControl, toggleSourceControl, openGitGraphFromContext } =
    useSourceControlContext({
      explorerRoot,
      cycleSidebarView,
      openCommitHistoryTab,
    });
  const explorerGitDecorations = usePreferencesStore(
    (s) => s.explorerGitDecorations,
  );

  const openBrowserTab = useCallback(
    (url: string, activate = true, spaceId?: string) => {
      const id = newBrowserTab(url, activate, spaceId);
      // Focus the address bar if the URL is empty so the user can type.
      if (activate && !url) {
        setTimeout(() => browserRefs.current.get(id)?.focusAddressBar(), 0);
      }
      return id;
    },
    [newBrowserTab],
  );

  const openFileInAnboBrowser = useCallback(
    (path: string) => {
      const url = filePathToBrowserUrl(path);
      if (url) openBrowserTab(url);
    },
    [openBrowserTab],
  );

  useEffect(() => {
    setBrowserOpenRequestHandler((payload) => {
      const responseEvent = `${BROWSER_OPEN_RESPONSE_EVENT}:${payload.requestId}`;
      let protocol: string;
      try {
        protocol = new URL(payload.url).protocol;
      } catch {
        protocol = "";
      }
      if (protocol !== "http:" && protocol !== "https:") {
        void emit(responseEvent, { error: "only HTTP(S) URLs are allowed" });
        return;
      }
      const { spaces, activeId: currentSpaceId } = useSpaces.getState();
      const resolved = resolveBrowserOpenSpace(spaces, payload.workspace);
      if (!resolved.ok) {
        void emit(responseEvent, { error: resolved.error });
        return;
      }
      const spaceId = resolved.space.id;
      const foregroundTabId = activeIdRef.current;
      const preserveForeground =
        spaceId === currentSpaceId &&
        tabsRef.current.some(
          (tab) => tab.id === foregroundTabId && tab.spaceId === spaceId,
        );
      const tabId = openBrowserTab(payload.url, false, spaceId);
      markBrowserAutomationActivity(tabId, "open");
      setActiveBrowserTabId(spaceId, tabId);
      if (preserveForeground) {
        const restoreForeground = () => {
          const current = activeIdRef.current;
          if (current === tabId || current === foregroundTabId) {
            setActiveId(foregroundTabId);
          }
        };
        queueMicrotask(restoreForeground);
        requestAnimationFrame(() => requestAnimationFrame(restoreForeground));
      }
      void emit(responseEvent, {
        tabId,
        spaceId,
        workspace: resolved.space.root,
        placement: browserOpenPlacement(spaceId, currentSpaceId),
      });
    });
  }, [openBrowserTab, setActiveBrowserTabId, setActiveId]);

  useEffect(() => {
    setBrowserCloseRequestHandler((payload) => {
      const responseEvent = `${BROWSER_CLOSE_RESPONSE_EVENT}:${payload.requestId}`;
      const { spaces } = useSpaces.getState();
      const resolved = resolveBrowserCloseTarget(
        tabsRef.current,
        spaces,
        payload.tabId,
        payload.workspace,
      );
      if (!resolved.ok) {
        void emit(responseEvent, { error: resolved.error });
        return;
      }
      closeTab(payload.tabId);
      void emit(responseEvent, {
        ok: true,
        tabId: payload.tabId,
        spaceId: resolved.space.id,
        workspace: resolved.space.root,
      });
    });
  }, [closeTab]);

  useEffect(() => {
    setBrowserPopupRequestHandler((payload) => {
      const decision = acceptBrowserPopupRequest(
        lastBrowserPopupRef.current,
        payload,
      );
      lastBrowserPopupRef.current = decision.stamp;
      if (!decision.accept) return;
      let protocol: string;
      try {
        protocol = new URL(payload.url).protocol;
      } catch {
        protocol = "";
      }
      if (protocol !== "http:" && protocol !== "https:") return;
      const { spaces } = useSpaces.getState();
      const resolved = resolveBrowserPopupSpace(
        tabsRef.current,
        spaces,
        payload.sourceTabId,
      );
      if (!resolved.ok) return;
      openBrowserTab(payload.url, false, resolved.space.id);
    });
  }, [openBrowserTab]);

  useEffect(() => {
    setBrowserTabsRequestHandler(({ requestId }) => {
      const { spaces, activeId: currentSpaceId } = useSpaces.getState();
      const activeBrowserId =
        tabsRef.current.find(
          (tab) => tab.id === activeIdRef.current && tab.kind === "browser",
        )?.id ?? null;
      const metadata = tabsRef.current.flatMap((tab) => {
        if (tab.kind !== "browser") return [];
        const space = spaces.find((candidate) => candidate.id === tab.spaceId);
        const automationMethod = getBrowserAutomationActivity(tab.id);
        return [
          {
            tabId: tab.id,
            title: tab.title,
            url: tab.url,
            spaceId: tab.spaceId,
            workspace: space?.root ?? null,
            active: activeBrowserId === tab.id,
            spaceActive: currentSpaceId === tab.spaceId,
            automationTarget: activeBrowserTabIds[tab.spaceId] === tab.id,
            automationActive: automationMethod !== null,
            automationMethod,
            loading: tab.loading === true,
            pendingUrl: null,
          },
        ];
      });
      void emit(`${BROWSER_TABS_RESPONSE_EVENT}:${requestId}`, {
        activeTabId: activeBrowserId,
        activeSpaceId: currentSpaceId,
        tabs: metadata,
      });
    });
  }, [activeBrowserTabIds]);

  useEffect(() => {
    let servicePromise:
      | Promise<
          ReturnType<
            typeof import("@/modules/agents/lib/agentAutomation")["createAgentAutomationService"]
          >
        >
      | undefined;
    const getService = () => {
      servicePromise ??= import("@/modules/agents/lib/agentAutomation").then(
        ({ createAgentAutomationService }) =>
          createAgentAutomationService({
            getTabs: () => tabsRef.current,
            getSpaces: () => useSpaces.getState().spaces,
            getSessions: () => useAgentStore.getState().sessions,
            getActiveTabId: () => activeIdRef.current,
            getBuffer: (leafId) => readTerminalBuffer(leafId, 400),
            write: writeToSession,
            spawn: (workspace, agent) => {
              const space = useSpaces
                .getState()
                .spaces.find(
                  (candidate) =>
                    candidate.id === workspace.id &&
                    candidate.root === workspace.root,
                );
              if (!space?.root) return null;
              const preferences = usePreferencesStore.getState();
              const request = configuredAgentLaunchRequest(
                agent,
                preferences.agentLaunchCommands,
                preferences.customCliAgents,
              );
              if (!request) return null;
              const launched = launchAgentGroupAtRef.current(request, {
                spaceId: space.id,
                root: space.root,
                cwd: space.root,
                workspace: space.env,
                activate: false,
              });
              if (!launched) return null;
              const tabId = launched.tabIds[0];
              const leafId = launched.leafIds[0];
              return {
                agentId: agentIdFor(request.agent, request.agent, tabId),
                cli: request.agent,
                tabId,
                leafId,
                spaceId: space.id,
                workspace: space.root,
              };
            },
            subscribeSessions: (listener) =>
              useAgentStore.subscribe((state, previous) =>
                listener(state.sessions, previous.sessions),
              ),
          }),
      );
      return servicePromise;
    };
    setAgentRequestHandler((payload) => {
      void getService()
        .then((service) => service.handle(payload))
        .then((response) =>
          emit(`${AGENT_RESPONSE_EVENT}:${payload.requestId}`, response),
        )
        .catch((caught: unknown) =>
          emit(`${AGENT_RESPONSE_EVENT}:${payload.requestId}`, {
            error: {
              code: "internal",
              message:
                caught instanceof Error
                  ? caught.message
                  : "agent request failed unexpectedly",
            },
          }),
        );
    });
    return () => {
      void servicePromise?.then((service) => service.dispose());
    };
  }, []);

  const splitActiveTabInDockview = useCallback(
    (position: "right" | "bottom") => {
      const source = tabsRef.current.find(
        (tab) => tab.id === activeIdRef.current,
      );
      if (source?.kind !== "terminal") return;
      const tabId = newTab(inheritedCwdForNewTab());
      setDockviewExternalSplits((splits) => [
        ...splits.slice(-99),
        {
          tabId,
          referenceTabId: source.id,
          position,
          spaceId: source.spaceId,
          revision: ++dockviewSplitRevision.current,
        },
      ]);
    },
    [inheritedCwdForNewTab, newTab],
  );

  const livePaneBounds = useCallback((tabId: number): PaneBounds[] => {
    const tab = document.querySelector<HTMLElement>(
      `[data-terminal-tab="${tabId}"]`,
    );
    if (!tab) return [];
    return [...tab.querySelectorAll<HTMLElement>("[data-pane-leaf]")].flatMap(
      (element) => {
        const id = Number(element.dataset.paneLeaf);
        if (!Number.isFinite(id)) return [];
        const { left, right, top, bottom } = element.getBoundingClientRect();
        return [{ id, left, right, top, bottom }];
      },
    );
  }, []);

  const swapActivePane = useCallback(
    (direction: "left" | "right" | "up" | "down") => {
      swapActivePaneInDirection(activeId, direction, livePaneBounds(activeId));
    },
    [activeId, livePaneBounds, swapActivePaneInDirection],
  );

  const handleCloseTabOrPane = useCallback(() => {
    const t = tabsRef.current.find((x) => x.id === activeId);
    if (t?.kind === "terminal" && leafIds(t.paneTree).length > 1) {
      void handleClosePane(activeId, t.activeLeafId);
      return;
    }
    void handleClose(activeId);
  }, [activeId, handleClose, handleClosePane]);

  const [zenMode, setZenMode] = useState(false);

  // Focus an agent's tab, switching to its space first so the header and tab
  // strip don't end up showing a different space than the focused pane.
  const activateAgentTarget = useCallback(
    (tabId: number, leafId: number) => {
      const tab = tabsRef.current.find((candidate) => candidate.id === tabId);
      if (tab?.kind !== "terminal" || !hasLeaf(tab.paneTree, leafId)) {
        return;
      }
      const currentSpaceId = useSpaces.getState().activeId;
      warmTab(tabId);
      focusPane(tabId, leafId);
      setActiveId(tabId);
      if (tab.spaceId !== currentSpaceId) {
        pendingAgentTargetRef.current = {
          spaceId: tab.spaceId,
          tabId,
          leafId,
        };
        useSpaces.getState().setActive(tab.spaceId);
        return;
      }
      focusAgentTerminal(leafId);
    },
    [setActiveId, warmTab, focusPane, focusAgentTerminal],
  );

  const shortcutHandlers = useMemo<ShortcutHandlers>(
    () => ({
      "commandPalette.open": () => openCommandPalette("commands"),
      "commandPalette.content": () => openCommandPalette("content"),
      "tab.new": openNewTab,
      "tab.newBlock": openNewBlockTab,
      "tab.newPrivate": openNewPrivateTab,
      "tab.newBrowser": () => openBrowserTab(""),
      "tab.newEditor": () => setNewEditorOpen(true),
      "tab.close": handleCloseTabOrPane,
      "tab.next": () => stepSwitcher(1),
      "tab.prev": () => stepSwitcher(-1),
      "tab.selectByIndex": (e) =>
        selectByIndex(
          parseInt(e.key, 10) - 1,
          activeSpaceId ?? DEFAULT_SPACE_ID,
        ),
      "space.next": () => cycleSpace(1),
      "space.prev": () => cycleSpace(-1),
      "space.overview": () => setSwitcherOpen(true),
      "pane.splitRight": () => splitActiveTabInDockview("right"),
      "pane.splitDown": () => splitActiveTabInDockview("bottom"),
      "pane.focusNext": () => focusNextPaneInTab(activeId, 1),
      "pane.focusPrev": () => focusNextPaneInTab(activeId, -1),
      "pane.swapLeft": () => swapActivePane("left"),
      "pane.swapRight": () => swapActivePane("right"),
      "pane.swapUp": () => swapActivePane("up"),
      "pane.swapDown": () => swapActivePane("down"),
      "pane.source": toggleSourceControl,
      "terminal.clear": () => {
        clearFocusedTerminal();
      },
      "terminal.toggleInput": () =>
        window.dispatchEvent(new CustomEvent(TOGGLE_BLOCK_INPUT_EVENT)),
      "blocks.prev": () => navigateFocusedBlocks(-1),
      "blocks.next": () => navigateFocusedBlocks(1),
      "search.focus": () => {
        const editor = editorRefs.current.get(activeId);
        if (editor) editor.openSearch();
        else searchInlineRef.current?.focus();
      },
      "ai.toggle": togglePanelAndFocus,
      "ai.toggleMini": () => {
        if (!hasComposer) {
          void openSettingsWindow("models");
          return;
        }
        toggleMini();
      },
      "ai.askSelection": askFromSelection,
      "agent.focusAttention": () => {
        const t = nextAttentionTarget();
        if (t) activateAgentTarget(t.tabId, t.leafId);
      },
      "settings.open": () => void openSettingsWindow(),
      "sidebar.toggle": toggleSidebar,
      "explorer.focus": toggleExplorerFocus,
      "view.zoomIn": zoomIn,
      "view.zoomOut": zoomOut,
      "view.zoomReset": zoomReset,
      "view.zenMode": () => setZenMode((v) => !v),
      "editor.undo": () => editorRefs.current.get(activeId)?.undo(),
      "editor.redo": () => editorRefs.current.get(activeId)?.redo(),
      "editor.aiComplete": () =>
        editorRefs.current.get(activeId)?.triggerAiComplete(),
      "editor.codeComplete": () =>
        editorRefs.current.get(activeId)?.triggerCodeComplete(),
    }),
    [
      activeId,
      openCommandPalette,
      stepSwitcher,
      cycleSpace,
      handleCloseTabOrPane,
      openNewTab,
      openNewBlockTab,
      openNewPrivateTab,
      openBrowserTab,
      activeSpaceId,
      selectByIndex,
      splitActiveTabInDockview,
      focusNextPaneInTab,
      swapActivePane,
      toggleSourceControl,
      hasComposer,
      togglePanelAndFocus,
      toggleMini,
      askFromSelection,
      toggleSidebar,
      toggleExplorerFocus,
      zoomIn,
      zoomOut,
      zoomReset,
      activateAgentTarget,
    ],
  );

  const shortcutsDisabled = useCallback(
    (id: ShortcutId, e: KeyboardEvent) => {
      const terminalPaneCount =
        activeTab?.kind === "terminal"
          ? leafIds(activeTab.paneTree).length
          : null;
      if (shouldDisablePaneSwapShortcut(id, terminalPaneCount)) return true;
      if (
        id === "editor.undo" ||
        id === "editor.redo" ||
        id === "editor.aiComplete" ||
        id === "editor.codeComplete"
      ) {
        return activeTab?.kind !== "editor";
      }
      if (id === "ai.askSelection") {
        const target =
          (e.target as HTMLElement | null) ?? document.activeElement;
        const inTerminal = !!(target as HTMLElement | null)?.closest?.(
          ".xterm",
        );
        if (!inTerminal) return false;
        const sel = captureActiveSelection();
        return !sel || !sel.trim();
      }
      if (id === "terminal.clear") {
        // Only intercept ⌘K while a terminal is focused; elsewhere let the key
        // fall through (we never preventDefault when disabled).
        const target =
          (e.target as HTMLElement | null) ?? document.activeElement;
        return !(target as HTMLElement | null)?.closest?.(".xterm");
      }
      if (
        id === "terminal.toggleInput" ||
        id === "blocks.prev" ||
        id === "blocks.next"
      ) {
        return !(activeTab?.kind === "terminal" && activeTab.blocks === true);
      }
      if (id === "sidebar.toggle") {
        // Ctrl+B is also Claude Code's "run in background" key. While a terminal
        // is focused, let Ctrl+B reach the shell/Claude instead of toggling the
        // sidebar. Ctrl+Shift+B (second binding) still toggles it from anywhere.
        const target =
          (e.target as HTMLElement | null) ?? document.activeElement;
        const inTerminal = !!(target as HTMLElement | null)?.closest?.(
          ".xterm",
        );
        // Only defer the plain (no-shift) Ctrl/⌘+B binding; the Shift variant
        // is the always-on toggle and is never claimed by the terminal.
        return inTerminal && !e.shiftKey;
      }
      return false;
    },
    [activeTab, captureActiveSelection],
  );

  useGlobalShortcuts(shortcutHandlers, { isDisabled: shortcutsDisabled });

  const registerTerminalHandle = useCallback(
    (leafId: number, h: TerminalPaneHandle | null) => {
      if (h) terminalRefs.current.set(leafId, h);
      else terminalRefs.current.delete(leafId);
    },
    [],
  );

  const registerEditorHandle = useCallback(
    (id: number, h: EditorPaneHandle | null) => {
      if (h) {
        editorRefs.current.set(id, h);
        const line = pendingGotoLine.current.get(id);
        if (line != null) {
          pendingGotoLine.current.delete(id);
          h.gotoLine(line);
        }
      } else {
        editorRefs.current.delete(id);
      }
      if (id === activeId) setActiveEditorHandle(h);
    },
    [activeId],
  );

  const registerBrowserHandle = useCallback(
    (
      id: number,
      h: BrowserPaneHandle | null,
      previous?: BrowserPaneHandle | null,
    ) => {
      if (h) browserRefs.current.set(id, h);
      else if (!previous || browserRefs.current.get(id) === previous) {
        browserRefs.current.delete(id);
      }
    },
    [],
  );

  const handleBrowserUrl = useCallback(
    (id: number, url: string) =>
      updateTab(id, { url, favicon: faviconUrlForPage(url) }),
    [updateTab],
  );

  const handleBrowserTitle = useCallback(
    (id: number, title: string) => updateTab(id, { title }),
    [updateTab],
  );

  const handleBrowserLoading = useCallback(
    (id: number, loading: boolean) => updateTab(id, { loading }),
    [updateTab],
  );

  const authorizedCwds = useRef(new Set<string>());
  const handleTerminalCwd = useCallback(
    (leafId: number, cwd: string) => {
      setLeafCwd(leafId, cwd);
      if (cwd && !authorizedCwds.current.has(cwd)) {
        authorizedCwds.current.add(cwd);
        native.workspaceAuthorize(cwd).catch(() => {
          authorizedCwds.current.delete(cwd);
        });
      }
    },
    [setLeafCwd],
  );

  const handleFocusLeaf = useCallback(
    (tabId: number, leafId: number) => focusPane(tabId, leafId),
    [focusPane],
  );

  const onActivateAgent = activateAgentTarget;

  const onActivateLocalAgent = useCallback(() => {
    openPanel();
    focusInput(null);
  }, [openPanel, focusInput]);

  const handleLeafExit = useCallback(
    (leafId: number, _code: number) => {
      const all = tabsRef.current;
      const tab = all.find(
        (t) => t.kind === "terminal" && hasLeaf(t.paneTree, leafId),
      );
      if (!tab || tab.kind !== "terminal") return;
      if (leafIds(tab.paneTree).length === 1) {
        if (all.length === 1) clearTabs();
        else closeTab(tab.id);
      } else {
        closePaneByLeaf(leafId);
      }
    },
    [closePaneByLeaf, closeTab, clearTabs],
  );

  const handleEditorDirty = useCallback(
    (id: number, dirty: boolean) => updateTab(id, { dirty }),
    [updateTab],
  );

  const handleRenameTab = useCallback(
    (id: number, title: string) => updateTab(id, { customTitle: title.trim() }),
    [updateTab],
  );

  const searchTarget = useMemo<SearchTarget>(() => {
    if (isTerminalTab && activeLeafId !== null && activeSearchAddon)
      return {
        kind: "terminal",
        addon: activeSearchAddon,
        focus: () => terminalRefs.current.get(activeLeafId)?.focus(),
      };
    if (isEditorTab && activeEditorHandle)
      return {
        kind: "editor",
        handle: activeEditorHandle,
        focus: () => activeEditorHandle.focus(),
      };
    if (isGitHistoryTab && gitHistoryHandle)
      return {
        kind: "git-history",
        handle: gitHistoryHandle,
        focus: () => {},
      };
    return null;
  }, [
    isTerminalTab,
    isEditorTab,
    isGitHistoryTab,
    activeLeafId,
    activeSearchAddon,
    activeEditorHandle,
    gitHistoryHandle,
  ]);

  const activeCwd = activeTerminalLeafCwd ?? explorerRoot;

  const handleNewSpace = useCallback(() => {
    const { spaces, create, setActive } = useSpaces.getState();
    const meta = create(newSpaceDefaults(spaces.length + 1, workspaceEnv));
    setActiveSpaceForNewTabs(meta.id);
    setActive(meta.id);
    setSwitcherOpen(false);
    return meta.id;
  }, [workspaceEnv, setActiveSpaceForNewTabs]);

  const handlePickFolder = useCallback(
    async (dir: string, name: string) => {
      try {
        await authorizeWorkspaceRoot({
          path: dir,
          workspace: workspaceEnv,
          authorize: native.workspaceAuthorize,
          commit: (authorizedRoot) => {
            const { create, setActive } = useSpaces.getState();
            const meta = create({
              name,
              root: authorizedRoot,
              env: workspaceEnv,
            });
            setActiveSpaceForNewTabs(meta.id);
            setActive(meta.id);
            clearTabs();
            markBooted();
          },
        });
      } catch (error) {
        console.error("[anbo] workspace authorization failed:", error);
        toast.error("Could not open workspace", {
          description: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [workspaceEnv, setActiveSpaceForNewTabs, clearTabs, markBooted],
  );

  const handleUseHome = useCallback(() => {
    if (!home) return;
    const defaultName = home.replace(/\/+$/, "").split("/").pop() || "Home";
    void handlePickFolder(home, defaultName);
  }, [home, handlePickFolder]);

  const handleConfigureActiveSpace = useCallback(
    async (dir: string, name: string) => {
      const { activeId, spaces, setRoot } = useSpaces.getState();
      if (!activeId) return;
      const target = spaces.find((space) => space.id === activeId);
      if (!target) return;
      try {
        await authorizeWorkspaceRoot({
          path: dir,
          workspace: target.env,
          authorize: native.workspaceAuthorize,
          commit: (authorizedRoot) => setRoot(activeId, authorizedRoot, name),
        });
      } catch (error) {
        console.error("[anbo] workspace authorization failed:", error);
        toast.error("Could not open workspace", {
          description: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [],
  );

  const handleUseHomeForActiveSpace = useCallback(() => {
    if (!home) return;
    const defaultName = home.replace(/\/+$/, "").split("/").pop() || "Home";
    void handleConfigureActiveSpace(home, defaultName);
  }, [home, handleConfigureActiveSpace]);

  const handleDeleteSpace = useCallback(
    async (id: string) => {
      const spaceTabs = tabsRef.current.filter((tab) => tab.spaceId === id);
      const terminalLeaves = spaceTabs.flatMap((tab) =>
        tab.kind === "terminal" ? leafIds(tab.paneTree) : [],
      );
      const checkedTabIds = spaceTabs.map((tab) => tab.id).join(",");
      const checkedLeafIds = terminalLeaves.join(",");
      const busyChecks = await Promise.all(
        terminalLeaves.map(leafHasForegroundProcess),
      );
      const busyTerminals = busyChecks.filter(Boolean).length;
      const currentSpaceTabs = tabsRef.current.filter(
        (tab) => tab.spaceId === id,
      );
      const dirtyEditors = currentSpaceTabs.filter(
        (tab) => tab.kind === "editor" && tab.dirty,
      ).length;
      const currentLeafIds = currentSpaceTabs
        .flatMap((tab) =>
          tab.kind === "terminal" ? leafIds(tab.paneTree) : [],
        )
        .join(",");
      const stateChanged =
        currentSpaceTabs.map((tab) => tab.id).join(",") !== checkedTabIds ||
        currentLeafIds !== checkedLeafIds;
      if (
        (dirtyEditors > 0 || busyTerminals > 0 || stateChanged) &&
        !window.confirm(
          `Delete this space? ${dirtyEditors} unsaved editor(s) and ${busyTerminals} detected running terminal process(es) will be closed.`,
        )
      ) {
        return;
      }
      const nextSpaceId = useSpaces.getState().remove(id);
      if (!nextSpaceId) return;
      const root = useSpaces
        .getState()
        .spaces.find((s) => s.id === nextSpaceId)?.root;
      removeTabsForSpace(id, nextSpaceId, root ?? undefined);
    },
    [removeTabsForSpace],
  );

  const handleMoveTab = useCallback(
    (tabId: number, targetSpaceId: string) => {
      if (moveTabToSpace(tabId, targetSpaceId)) {
        useSpaces.getState().setActive(targetSpaceId);
      }
    },
    [moveTabToSpace],
  );

  const handleReorderTab = useCallback(
    (tabId: number, targetTabId: number, edge: "top" | "bottom") => {
      const target = tabsRef.current.find((tab) => tab.id === targetTabId);
      if (!target) return;
      const followTargetSpace = reorderTab(tabId, targetTabId, edge);
      setDockviewExternalMoves((moves) => [
        ...moves.slice(-99),
        {
          tabId,
          targetTabId,
          placement: edge === "top" ? "before" : "after",
          spaceId: target.spaceId,
          revision: ++dockviewMoveRevision.current,
        },
      ]);
      if (followTargetSpace) {
        useSpaces.getState().setActive(target.spaceId);
      }
    },
    [reorderTab],
  );

  const handleNewTabInSpace = useCallback(
    (spaceId: string) => {
      const root = useSpaces
        .getState()
        .spaces.find((s) => s.id === spaceId)?.root;
      newTabInSpace(spaceId, root ?? undefined);
    },
    [newTabInSpace],
  );

  const jumpToTab = useCallback(
    (tabId: number) => {
      const t = tabsRef.current.find((x) => x.id === tabId);
      if (!t) return;
      setActiveId(tabId);
      useSpaces.getState().setActive(t.spaceId);
      setSwitcherOpen(false);
    },
    [setActiveId],
  );

  const spaceSwitcher = (
    <SpaceSwitcher
      open={switcherOpen}
      onOpenChange={setSwitcherOpen}
      tabs={tabs}
      onNewSpace={() => void handleNewSpace()}
      onDeleteSpace={handleDeleteSpace}
      onNewTabInSpace={handleNewTabInSpace}
      onJumpTab={jumpToTab}
      onCloseTab={handleClose}
      onMoveTabToSpace={handleMoveTab}
      onReorderTab={handleReorderTab}
      onReorderSpaces={(ids) => useSpaces.getState().reorder(ids)}
    />
  );

  const commandPaletteItems = useMemo(
    () =>
      commandPaletteOpen
        ? createCommandItems({
            tabs,
            activeId,
            searchTarget,
            explorerRoot,
            home,
            openNewTab,
            openNewBlock: openNewBlockTab,
            openNewPrivate: openNewPrivateTab,
            openNewEditor: () => setNewEditorOpen(true),
            openNewBrowser: () => openBrowserTab(""),
            openGitGraph: openGitGraphFromContext,
            toggleSourceControl,
            closeActiveTabOrPane: handleCloseTabOrPane,
            splitPaneRight: () => splitActiveTabInDockview("right"),
            splitPaneDown: () => splitActiveTabInDockview("bottom"),
            focusSearch: () => searchInlineRef.current?.focus(),
            focusExplorerSearch: () => explorerRef.current?.focusSearch(),
            toggleSidebar,
            toggleAi: togglePanelAndFocus,
            askAiSelection: askFromSelection,
            openSettings: () => void openSettingsWindow(),
            openKeyboardShortcuts: () => void openSettingsWindow("shortcuts"),
            spaces: useSpaces.getState().spaces,
            activeSpaceId,
            openSpacesOverview: () => setSwitcherOpen(true),
            newSpace: () => void handleNewSpace(),
            switchSpace: (id) => useSpaces.getState().setActive(id),
          })
        : [],
    [
      commandPaletteOpen,
      tabs,
      activeId,
      searchTarget,
      explorerRoot,
      home,
      openNewTab,
      openNewBlockTab,
      openNewPrivateTab,
      openBrowserTab,
      openGitGraphFromContext,
      toggleSourceControl,
      handleCloseTabOrPane,
      splitActiveTabInDockview,
      toggleSidebar,
      togglePanelAndFocus,
      askFromSelection,
      activeSpaceId,
      handleNewSpace,
    ],
  );

  const pendingGotoLine = useRef<Map<number, number>>(new Map());
  const openContentHit = useCallback(
    (path: string, line: number) => {
      const id = openFileTab(path, true);
      if (id == null) return;
      const h = editorRefs.current.get(id);
      if (h) h.gotoLine(line);
      else pendingGotoLine.current.set(id, line);
    },
    [openFileTab],
  );

  useEffect(() => {
    setLspNavigator({ openFile: openContentHit });
    return () => setLspNavigator(null);
  }, [openContentHit]);

  const insertHistoryCommand = useMemo(
    () =>
      isTerminalTab && activeLeafId !== null
        ? (cmd: string) => {
            writeToSession(activeLeafId, cmd);
            terminalRefs.current.get(activeLeafId)?.focus();
          }
        : null,
    [isTerminalTab, activeLeafId],
  );

  useAiLiveBridge({
    setLive,
    activeId,
    tabs,
    explorerRoot,
    launchCwd,
    home,
    openBrowserTab,
    closeTab,
    activeSpaceId: activeSpaceId ?? DEFAULT_SPACE_ID,
    activeBrowserTabIds,
    setActiveBrowserTabId,
    browserRefs,
    newAgentTab,
    terminalRefs,
    workspace: workspaceForSpace(activeSpaceId ?? DEFAULT_SPACE_ID),
  });

  const shell = (
    <ThemeProvider>
      <TooltipProvider>
        <div className="anbo-app-shell relative flex h-full flex-col overflow-hidden bg-background text-foreground">
          {showLanding ? (
            <LandingPage
              onPick={handlePickFolder}
              onUseHome={handleUseHome}
              home={home}
              showWindowControls
            />
          ) : (
            <>
              {!zenMode && (
                <Header
                  onToggleSidebar={toggleSidebar}
                  onOpenCommandPalette={() => openCommandPalette("commands")}
                  onActivateAgent={onActivateAgent}
                  onActivateLocalAgent={onActivateLocalAgent}
                  onOpenSettings={() => void openSettingsWindow()}
                  spaceSwitcher={spaceSwitcher}
                  searchTarget={searchTarget}
                  searchRef={searchInlineRef}
                  workspaceRoot={activeSpaceRoot}
                  workspace={workspaceForSpace(
                    activeSpaceId ?? DEFAULT_SPACE_ID,
                  )}
                />
              )}

              <main className="zoom-content flex min-h-0 flex-1 flex-col">
                <ResizablePanelGroup
                  orientation="horizontal"
                  className="min-h-0 flex-1"
                  onLayoutChanged={(_, { isUserInteraction }) => {
                    const width = sidebarRef.current?.getSize().inPixels ?? 0;
                    persistSidebarWidth(width, isUserInteraction);
                    const collapsed =
                      sidebarRef.current?.isCollapsed() ?? false;
                    persistSidebarCollapsed(collapsed, isUserInteraction);
                  }}
                >
                  <ResizablePanel
                    id="sidebar"
                    panelRef={sidebarRef}
                    groupResizeBehavior="preserve-pixel-size"
                    defaultSize={
                      initialSidebarCollapsed
                        ? "0px"
                        : `${sidebarWidthRef.current}px`
                    }
                    minSize={`${SIDEBAR_MIN_WIDTH}px`}
                    maxSize={`${SIDEBAR_MAX_WIDTH}px`}
                    collapsible
                    collapsedSize={0}
                  >
                    <div className="flex h-full min-h-0 flex-col border-r border-border/60 bg-card">
                      <div
                        key={sidebarView}
                        className="min-h-0 flex-1 anbo-panel-in"
                      >
                        {sidebarView === "explorer" ? (
                          <FileExplorer
                            ref={explorerRef}
                            rootPath={explorerRoot}
                            gitStatus={
                              explorerGitDecorations
                                ? sourceControl.status
                                : null
                            }
                            activeFilePath={explorerActiveFilePath}
                            onOpenFile={handleOpenFile}
                            onOpenInBrowser={openFileInAnboBrowser}
                            onPathRenamed={handlePathRenamed}
                            onPathDeleted={handlePathDeleted}
                            onRevealInTerminal={cdInNewTab}
                            onAttachToAgent={handleAttachFileToAgent}
                            pathDropTarget={terminalPathDropTarget}
                          />
                        ) : (
                          <SourceControlPanel
                            open
                            sourceControl={sourceControl}
                            onOpenDiff={openGitDiffTab}
                            onOpenGitGraph={openGitGraphFromContext}
                            onOpenFile={handleOpenFile}
                            onNavigateToPath={cdInNewTab}
                          />
                        )}
                      </div>
                      <SidebarRail
                        activeView={sidebarView}
                        onSelectView={persistSidebarView}
                        changedCount={sourceControl.changedCount}
                      />
                    </div>
                  </ResizablePanel>
                  <ResizableHandle withHandle />
                  <ResizablePanel
                    id="workspace"
                    defaultSize="78%"
                    minSize="30%"
                  >
                    <div className="flex h-full min-h-0 flex-col">
                      <div className="relative min-h-0 flex-1">
                        {spacesHydrated ? (
                          <WorkspaceDockview
                            spaceId={activeSpaceId ?? DEFAULT_SPACE_ID}
                            tabs={spaceTabs}
                            activeId={activeId}
                            hideTabs={zenMode}
                            externalMoves={dockviewExternalMoves}
                            externalSplits={dockviewExternalSplits}
                            onLayoutSettled={refitVisibleTerminalSlots}
                            onSelect={setActiveId}
                            onRevealTab={warmTab}
                            onTabVisibilityChange={handleDockviewTabVisibility}
                            onNew={openNewTab}
                            onNewBlock={openNewBlockTab}
                            onNewPrivate={openNewPrivateTab}
                            onNewBrowser={() => openBrowserTab("")}
                            onNewEditor={() => setNewEditorOpen(true)}
                            onNewGitGraph={openGitGraphFromContext}
                            onLaunchAgents={launchAgentGroup}
                            onClose={handleClose}
                            onPin={pinTab}
                            onRename={handleRenameTab}
                            onReorder={reorderTabByGap}
                            onOverrideLanguage={setOverrideLanguage}
                            renderTab={(tab, visible) => (
                              <WorkspaceSurface
                                tabs={[tab]}
                                workspace={workspaceForSpace(tab.spaceId)}
                                activeId={visible ? tab.id : -1}
                                activeTab={visible ? tab : undefined}
                                registerTerminalHandle={registerTerminalHandle}
                                onSearchReady={handleSearchReady}
                                onCwd={handleTerminalCwd}
                                onExit={handleLeafExit}
                                onFocusLeaf={handleFocusLeaf}
                                registerEditorHandle={registerEditorHandle}
                                onEditorDirtyChange={handleEditorDirty}
                                onEditorCloseTab={handleClose}
                                registerBrowserHandle={registerBrowserHandle}
                                onBrowserUrlChange={handleBrowserUrl}
                                onBrowserTitleChange={handleBrowserTitle}
                                onBrowserLoadingChange={handleBrowserLoading}
                                getBrowserWorkspaceContext={
                                  browserWorkspaceContext
                                }
                                onAiDiffAccept={(id) =>
                                  respondToApproval(id, true)
                                }
                                onAiDiffReject={(id) =>
                                  respondToApproval(id, false)
                                }
                                onOpenCommitFile={openCommitFileDiffTab}
                                onGitHistorySearchHandle={getGitHistoryHandleCallback(
                                  tab.id,
                                )}
                                onSetMarkdownView={setMarkdownView}
                              />
                            )}
                          />
                        ) : null}
                        {spacesHydrated && backgroundBrowserTabs.length > 0 ? (
                          <div
                            className="invisible pointer-events-none absolute inset-0"
                            aria-hidden
                          >
                            <BrowserStack
                              tabs={backgroundBrowserTabs}
                              activeId={-1}
                              registerHandle={registerBrowserHandle}
                              onUrlChange={handleBrowserUrl}
                              onTitleChange={handleBrowserTitle}
                              onLoadingChange={handleBrowserLoading}
                              getWorkspaceContext={browserWorkspaceContext}
                            />
                          </div>
                        ) : null}
                        {spacesHydrated && backgroundTerminalTabs.length > 0 ? (
                          <div
                            className="invisible pointer-events-none absolute inset-0"
                            aria-hidden
                          >
                            <TerminalStack
                              tabs={backgroundTerminalTabs}
                              activeId={-1}
                              registerHandle={registerTerminalHandle}
                              onSearchReady={handleSearchReady}
                              onCwd={handleTerminalCwd}
                              onExit={handleLeafExit}
                              onFocusLeaf={handleFocusLeaf}
                            />
                          </div>
                        ) : null}
                        {spacesHydrated && showWorkspaceWelcome ? (
                          <div className="absolute inset-0 z-10 bg-background">
                            {activeSpaceRoot ? (
                              <WorkspaceWelcome
                                name={activeSpaceName}
                                folder={activeSpaceRoot}
                                onNew={() => newTab(activeSpaceRoot)}
                                onNewBlock={() => newBlockTab(activeSpaceRoot)}
                                onNewPrivate={() =>
                                  newPrivateTab(activeSpaceRoot)
                                }
                                onNewBrowser={() => openBrowserTab("")}
                                onNewEditor={() => setNewEditorOpen(true)}
                                onNewGitGraph={openGitGraphFromContext}
                                onLaunchAgents={launchAgentGroup}
                              />
                            ) : (
                              <LandingPage
                                title={activeSpaceName ?? "New workspace"}
                                description="Choose a folder for this workspace before opening tabs."
                                onPick={handleConfigureActiveSpace}
                                onUseHome={handleUseHomeForActiveSpace}
                                home={home}
                              />
                            )}
                          </div>
                        ) : null}
                      </div>

                      {showWorkspaceWelcome ? null : (
                        <WorkspaceInputBar
                          isBlockTab={isBlockTab}
                          isTerminalTab={isTerminalTab}
                          activeLeafId={activeLeafId}
                          cwd={activeCwd}
                          home={home}
                          hasComposer={hasComposer}
                          panelOpen={panelOpen}
                          keysLoaded={keysLoaded}
                          onConnect={() => void openSettingsWindow("models")}
                        />
                      )}
                    </div>
                  </ResizablePanel>
                </ResizablePanelGroup>
              </main>

              {!zenMode && (
                <StatusBar
                  cwd={activeCwd}
                  filePath={activeFilePath}
                  home={home}
                  onCd={sendCd}
                  onWorkspaceChange={handleWorkspaceChange}
                  onOpenMini={openMini}
                  onOpenAi={togglePanelAndFocus}
                  hasComposer={hasComposer}
                  privateActive={
                    activeTab?.kind === "terminal" && activeTab.private === true
                  }
                />
              )}

              <AgentNotificationsBridge
                tabs={tabs}
                spaces={spaceEnvironments}
                activeId={activeId}
                onActivate={onActivateAgent}
                onStarted={handleAgentStarted}
                onSettled={handleAgentSettled}
                onExit={handleAgentExited}
              />
              <Toaster position="bottom-right" />

              {hasComposer ? (
                <>
                  <AgentRunBridge
                    openAiDiffTab={openAiDiffTab}
                    closeAiDiffTab={closeAiDiffTab}
                  />
                  <LocalAgentNotificationsBridge
                    workspaceName={activeSpaceName ?? undefined}
                  />
                </>
              ) : null}

              {hasComposer && miniPresence.mounted ? (
                <AiMiniWindow state={miniPresence.state} />
              ) : null}
              {askPresence.mounted ? (
                <SelectionAskAi
                  state={askPresence.state}
                  x={askPopup?.x ?? 0}
                  y={askPopup?.y ?? 0}
                  onAsk={onAskFromSelection}
                  onDismiss={() => setAskPopup(null)}
                />
              ) : null}

              {switcherState && (
                <TabSwitcherHud tabs={spaceTabs} state={switcherState} />
              )}

              <CommandPalette
                open={commandPaletteOpen}
                onOpenChange={setCommandPaletteOpen}
                initialMode={paletteInitialMode}
                commandItems={commandPaletteItems}
                workspaceRoot={explorerRoot}
                onOpenContentHit={openContentHit}
                insertCommand={insertHistoryCommand}
              />

              <NewEditorDialog
                open={newEditorOpen}
                onOpenChange={setNewEditorOpen}
                rootPath={explorerRoot ?? home}
                onCreated={(path) => openFileTab(path)}
              />

              <UpdaterDialog />

              <CloseDialogs
                tabs={tabs}
                pendingCloseTab={pendingCloseTab}
                onCancelClose={cancelClose}
                onConfirmClose={confirmClose}
                pendingTerminalCloseTab={pendingTerminalCloseTab}
                pendingTerminalCloseLeaf={pendingTerminalCloseLeaf}
                onCancelTerminalClose={cancelTerminalClose}
                onConfirmTerminalClose={confirmTerminalClose}
                pendingDeleteTabs={pendingDeleteTabs}
                onCancelDeleteClose={cancelDeleteClose}
                onConfirmDeleteClose={confirmDeleteClose}
                pendingAppClose={pendingAppClose}
                onCancelAppClose={cancelAppClose}
                onConfirmAppClose={confirmAppClose}
              />
            </>
          )}
        </div>
      </TooltipProvider>
    </ThemeProvider>
  );

  return <AiComposerProvider>{shell}</AiComposerProvider>;
}
