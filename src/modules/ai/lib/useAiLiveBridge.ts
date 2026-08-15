import { useManagedAgentsStore } from "@/modules/agents/store/managedAgentsStore";
import {
  type BrowserPaneHandle,
  markBrowserAutomationActivity,
} from "@/modules/browser";
import type { Tab } from "@/modules/tabs";
import {
  findLeafCwd,
  type TerminalPaneHandle,
  writeToReadySession,
  writeToSession,
} from "@/modules/terminal";
import { invoke } from "@tauri-apps/api/core";
import { type RefObject, useEffect, useRef } from "react";
import type { Live } from "../store/chatStore";
import { redactSensitive } from "./redact";

type TuiWaitResult = "ready" | "timeout";

export function isClaudeTuiReady(buffer: string | null): boolean {
  if (!buffer) return false;
  return (
    buffer.includes("shortcuts") ||
    buffer.includes("? for") ||
    (buffer.includes("Claude Code") && /(?:^|\n)\s*❯\s/u.test(buffer))
  );
}

export async function waitForClaudeTuiReady(
  readBuf: () => string | null,
  timeoutMs = 30_000,
  pollMs = 120,
): Promise<TuiWaitResult> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const buf = readBuf();
    if (isClaudeTuiReady(buf)) return "ready";
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return "timeout";
}

type Params = {
  setLive: (live: Live) => void;
  activeId: number;
  tabs: Tab[];
  explorerRoot: string | null;
  launchCwd: string | null;
  home: string | null;
  openBrowserTab: (url: string, activate?: boolean, spaceId?: string) => number;
  closeTab: (tabId: number) => void;
  activeSpaceId: string;
  activeBrowserTabIds: Record<string, number | null>;
  setActiveBrowserTabId: (spaceId: string, id: number | null) => void;
  browserRefs: RefObject<Map<number, BrowserPaneHandle>>;
  newAgentTab: (
    cwd: string | undefined,
    title: string,
  ) => { tabId: number; leafId: number };
  terminalRefs: RefObject<Map<number, TerminalPaneHandle>>;
};

/**
 * Publishes the live workspace context (cwd, terminal buffer, active file,
 * managed-agent spawning, ...) into the chat store so AI tools can read and
 * act on the foreground state.
 *
 * The live object's getters read the latest state through a ref, so the bridge
 * is published once instead of re-running on every tab/cwd change. Cwd updates
 * arrive from terminal OSC on shell output and would otherwise churn constantly.
 */
export type BrowserLiveDeps = {
  openTab: (url: string, activate: boolean, spaceId: string) => number;
  closeTab: (tabId: number) => void;
  getActiveSpaceId: () => string;
  getTargetForSpace: (spaceId: string) => number | null;
  setTargetForSpace: (spaceId: string, id: number | null) => void;
  getTabs: () => Tab[];
  getActiveId: () => number;
  getBrowser: (id: number) => BrowserPaneHandle | undefined;
};

export function resolveAutomationTarget(
  d: BrowserLiveDeps,
  space = d.getActiveSpaceId(),
): number | null {
  const tabs = d.getTabs();
  const target = d.getTargetForSpace(space);
  if (
    target != null &&
    tabs.some(
      (tab) =>
        tab.id === target &&
        tab.kind === "browser" &&
        !tab.cold &&
        tab.spaceId === space,
    )
  ) {
    return target;
  }
  const activeId = d.getActiveId();
  const active = tabs.find((tab) => tab.id === activeId);
  return active?.kind === "browser" && !active.cold && active.spaceId === space
    ? activeId
    : null;
}

export function buildBrowserLive(d: BrowserLiveDeps) {
  return {
    openBrowser: (url: string, requestedSpace?: string) => {
      const space = requestedSpace ?? d.getActiveSpaceId();
      const id = d.openTab(url, false, space);
      d.setTargetForSpace(space, id);
      markBrowserAutomationActivity(id, "open");
      return true;
    },
    navigateBrowser: (url: string, requestedSpace?: string) => {
      const space = requestedSpace ?? d.getActiveSpaceId();
      const target = resolveAutomationTarget(d, space);
      if (target == null) {
        const id = d.openTab(url, false, space);
        d.setTargetForSpace(space, id);
        markBrowserAutomationActivity(id, "open");
        return true;
      }
      const browser = d.getBrowser(target);
      if (!browser) return false;
      markBrowserAutomationActivity(target, "navigate");
      browser.navigate(url);
      return true;
    },
    getActiveBrowserTabId: (requestedSpace?: string) =>
      resolveAutomationTarget(d, requestedSpace ?? d.getActiveSpaceId()),
    switchBrowserTab: (tabId: number, requestedSpace?: string) => {
      const space = requestedSpace ?? d.getActiveSpaceId();
      const tab = d.getTabs().find((t) => t.id === tabId);
      if (tab?.kind !== "browser" || tab.cold || tab.spaceId !== space)
        return false;
      d.setTargetForSpace(space, tabId);
      return true;
    },
    closeBrowserTab: (tabId: number, requestedSpace?: string) => {
      const space = requestedSpace ?? d.getActiveSpaceId();
      const tab = d.getTabs().find((t) => t.id === tabId);
      if (tab?.kind !== "browser" || tab.cold || tab.spaceId !== space)
        return false;
      d.closeTab(tabId);
      if (resolveAutomationTarget(d, space) === tabId) {
        d.setTargetForSpace(space, null);
      }
      return true;
    },
  };
}

export function useAiLiveBridge(params: Params) {
  const { browserRefs, setLive, terminalRefs } = params;
  const ref = useRef(params);
  ref.current = params;

  useEffect(() => {
    const findCwd = () => {
      const { activeId, tabs, explorerRoot, launchCwd, home } = ref.current;
      const active = tabs.find((x) => x.id === activeId);
      if (active?.kind === "terminal") {
        return (
          findLeafCwd(active.paneTree, active.activeLeafId) ??
          active.cwd ??
          null
        );
      }
      for (let i = tabs.length - 1; i >= 0; i--) {
        const t = tabs[i];
        if (t.kind !== "terminal") continue;
        const cwd = findLeafCwd(t.paneTree, t.activeLeafId) ?? t.cwd;
        if (cwd) return cwd;
      }
      return explorerRoot ?? launchCwd ?? home ?? null;
    };

    setLive({
      getCwd: findCwd,
      getTerminalContext: () => {
        const { activeId, tabs } = ref.current;
        const t = tabs.find((x) => x.id === activeId);
        if (t?.kind !== "terminal") return null;
        if (t.private) return null;
        const buf = terminalRefs.current.get(t.activeLeafId)?.getBuffer(300);
        return buf ? redactSensitive(buf) : null;
      },
      isActiveTerminalPrivate: () => {
        const { activeId, tabs } = ref.current;
        const t = tabs.find((x) => x.id === activeId);
        return t?.kind === "terminal" && t.private === true;
      },
      injectIntoActivePty: (text) => {
        const { activeId, tabs } = ref.current;
        const t = tabs.find((x) => x.id === activeId);
        if (t?.kind !== "terminal") return false;
        const term = terminalRefs.current.get(t.activeLeafId);
        if (!term) return false;
        term.write(text);
        term.focus();
        return true;
      },
      getWorkspaceRoot: () => {
        const { explorerRoot, launchCwd, home } = ref.current;
        return explorerRoot ?? launchCwd ?? home ?? null;
      },
      getActiveFile: () => {
        const { activeId, tabs } = ref.current;
        const t = tabs.find((x) => x.id === activeId);
        return t?.kind === "editor" ? t.path : null;
      },
      getActiveSpaceId: () => ref.current.activeSpaceId,
      ...buildBrowserLive({
        openTab: (url, activate, spaceId) =>
          ref.current.openBrowserTab(url, activate, spaceId),
        closeTab: (tabId) => ref.current.closeTab(tabId),
        getActiveSpaceId: () => ref.current.activeSpaceId,
        getTargetForSpace: (space) =>
          ref.current.activeBrowserTabIds[space] ?? null,
        setTargetForSpace: (space, id) =>
          ref.current.setActiveBrowserTabId(space, id),
        getTabs: () => ref.current.tabs,
        getActiveId: () => ref.current.activeId,
        getBrowser: (id) => browserRefs.current.get(id),
      }),
      spawnManagedAgent: (prompt: string, sessionId: string) => {
        const trimmed = prompt.trim();
        if (!trimmed) return null;
        const oneLine = trimmed.replace(/\s*\r?\n\s*/g, " ");
        const cwd = findCwd();
        const short =
          oneLine.length > 32 ? `${oneLine.slice(0, 32)}…` : oneLine;
        const { tabId, leafId } = ref.current.newAgentTab(
          cwd ?? undefined,
          `claude · ${short}`,
        );
        useManagedAgentsStore
          .getState()
          .register({ leafId, tabId, sessionId, task: oneLine, cwd });
        void invoke("agent_enable_hooks", {
          agent: "claude",
        }).catch(() => {});
        void (async () => {
          if (!(await writeToReadySession(leafId, "claude\r", 15_000))) {
            useManagedAgentsStore.getState().setPhase(leafId, "attention");
            return;
          }
          const readBuf = () => {
            const term = terminalRefs.current.get(leafId);
            return term ? term.getBuffer(120) : null;
          };
          const result = await waitForClaudeTuiReady(readBuf);
          if (result !== "ready") {
            console.warn(
              "[anbo] Claude TUI did not become ready; prompt is still pending",
            );
            useManagedAgentsStore.getState().setPhase(leafId, "attention");
            return;
          }
          if (!writeToSession(leafId, `\x1b[200~${trimmed}\x1b[201~`)) {
            useManagedAgentsStore.getState().setPhase(leafId, "attention");
            return;
          }
          setTimeout(() => writeToSession(leafId, "\r"), 120);
          useManagedAgentsStore.getState().setPhase(leafId, "working");
        })();
        return { tabId, leafId };
      },
      readLeafBuffer: (leafId: number) => {
        const buf = terminalRefs.current.get(leafId)?.getBuffer(300);
        return buf ? redactSensitive(buf) : null;
      },
    });
  }, [browserRefs, setLive, terminalRefs]);
}
