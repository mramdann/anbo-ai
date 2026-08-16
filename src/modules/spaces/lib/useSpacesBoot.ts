import { native } from "@/modules/ai/lib/native";
import { usePreferencesStore } from "@/modules/settings/preferences";
import type { Tab } from "@/modules/tabs";
import { DEFAULT_SPACE_ID } from "@/modules/tabs/lib/useTabs";
import { isLeaf, type PaneNode } from "@/modules/terminal/lib/panes";
import { parseWorkspaceScopeKey, type WorkspaceEnv } from "@/modules/workspace";
import { useEffect, useRef } from "react";
import {
  activeSpaceEnv,
  freshTabCwd,
  shouldCreateFreshTerminal,
} from "./activeSpace";
import { freshTerminalTab, hydrateTabs } from "./serialize";
import { loadAll, type SpaceMeta, saveActiveId, saveSpacesList } from "./store";
import { useSpaces } from "./useSpaces";

type Params = {
  ready: boolean;
  launchCwd: string | null;
  home: string | null;
  hasExplicitLaunchDir: boolean;
  allocId: () => number;
  replaceTabs: (tabs: Tab[], activeId: number) => void;
  markBooted: () => void;
  setActiveSpaceForNewTabs: (id: string) => void;
  adoptWorkspaceEnv: (env: WorkspaceEnv) => Promise<string | null>;
};

function uniqueCwds(tabs: Tab[]): string[] {
  const set = new Set<string>();
  const walk = (n: PaneNode) => {
    if (isLeaf(n)) {
      if (n.cwd) set.add(n.cwd);
      return;
    }
    for (const c of n.children) walk(c);
  };
  for (const t of tabs) if (t.kind === "terminal") walk(t.paneTree);
  return [...set];
}

export function useSpacesBoot({
  ready,
  launchCwd,
  home,
  hasExplicitLaunchDir,
  allocId,
  replaceTabs,
  markBooted,
  setActiveSpaceForNewTabs,
  adoptWorkspaceEnv,
}: Params) {
  const done = useRef(false);

  useEffect(() => {
    if (!ready || done.current) return;
    done.current = true;

    void (async () => {
      let landed = false;
      try {
        const { spaces, activeId, states } = await loadAll();

        if (spaces.length === 0) {
          if (!hasExplicitLaunchDir) {
            // Cold open tanpa folder pilihan → tampilkan landing page.
            // Jangan bikin space/terminal & jangan markBooted → tab eager tetap
            // `cold` → selectLiveTerminals abaikan → tak ada PTY spawn di home.
            useSpaces.getState().hydrate([], null);
            landed = true;
            return;
          }
          const root = launchCwd ?? home ?? null;
          // Hydrate prefs before reading the saved workspace env.
          await usePreferencesStore
            .getState()
            .init()
            .catch(() => {});
          const meta: SpaceMeta = {
            id: DEFAULT_SPACE_ID,
            name: "Default",
            root,
            env: parseWorkspaceScopeKey(
              usePreferencesStore.getState().defaultWorkspaceEnv,
            ),
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
          await saveSpacesList([meta]);
          await saveActiveId(DEFAULT_SPACE_ID);
          setActiveSpaceForNewTabs(DEFAULT_SPACE_ID);
          useSpaces.getState().hydrate([meta], DEFAULT_SPACE_ID);
          return;
        }

        const restored: Tab[] = [];
        for (const space of spaces) {
          const st = states.get(space.id);
          if (!st) continue;
          restored.push(...hydrateTabs(st.tabs, space.id, allocId));
        }

        const active =
          activeId && spaces.some((s) => s.id === activeId)
            ? activeId
            : spaces[0].id;
        setActiveSpaceForNewTabs(active);

        // Apply the space's env+home before the fresh-tab fallback and spawns
        // below; env is set synchronously so cwd resolution picks WSL vs local.
        const env = activeSpaceEnv(spaces, active);
        const restoredHome = await adoptWorkspaceEnv(env);

        const activeSpace = spaces.find((space) => space.id === active);
        // Configured workspaces retain the historical fresh-terminal fallback.
        // An unconfigured new workspace must stay empty so its folder landing
        // survives an app restart.
        const hasRestoredActiveTab = restored.some(
          (tab) => tab.spaceId === active,
        );
        if (
          shouldCreateFreshTerminal(
            activeSpace?.root ?? null,
            hasRestoredActiveTab,
          ) &&
          activeSpace?.root
        ) {
          const cwd = freshTabCwd(
            env,
            restoredHome,
            launchCwd,
            home,
            activeSpace.root,
          );
          restored.push(freshTerminalTab(active, cwd, allocId));
        }

        await Promise.allSettled([
          ...spaces.flatMap((space) =>
            space.root
              ? [native.workspaceAuthorize(space.root, space.env)]
              : [],
          ),
          ...uniqueCwds(restored).map((cwd) => native.workspaceAuthorize(cwd)),
        ]);

        const initialActiveIndex: Record<string, number> = {};
        for (const [id, st] of states)
          initialActiveIndex[id] = st.activeTabIndex;
        useSpaces.getState().hydrate(spaces, active, initialActiveIndex);

        const inActive = restored.filter((t) => t.spaceId === active);
        const idx = states.get(active)?.activeTabIndex ?? 0;
        const activeTab = inActive[idx] ?? inActive[0];
        replaceTabs(restored, activeTab?.id ?? -1);
      } catch (e) {
        console.error("[anbo] spaces boot failed:", e);
      } finally {
        if (!landed) markBooted();
      }
    })();
  }, [
    ready,
    launchCwd,
    home,
    hasExplicitLaunchDir,
    allocId,
    replaceTabs,
    markBooted,
    setActiveSpaceForNewTabs,
    adoptWorkspaceEnv,
  ]);
}
