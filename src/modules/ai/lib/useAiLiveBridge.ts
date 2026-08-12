import { type RefObject, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useManagedAgentsStore } from "@/modules/agents/store/managedAgentsStore";
import type { BrowserPaneHandle } from "@/modules/browser";
import {
  findLeafCwd,
  type TerminalPaneHandle,
  whenSessionReady,
  writeToSession,
} from "@/modules/terminal";
import type { Tab } from "@/modules/tabs";
import type { Live } from "../store/chatStore";
import { redactSensitive } from "./redact";

type TuiWaitResult = "ready" | "gone" | "timeout";

async function waitForClaudeTuiReady(
  readBuf: () => string | null,
  timeoutMs = 8000,
): Promise<TuiWaitResult> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const buf = readBuf();
    if (buf === null) return "gone";
    if (buf.includes("shortcuts") || buf.includes("? for")) return "ready";
    await new Promise((r) => setTimeout(r, 120));
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
  openBrowserTab: (url: string, activate?: boolean) => number;
  activateTab: (tabId: number) => void;
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
 * is published once instead of re-running on every tab/cwd change — cwd updates
 * arrive from terminal OSC on shell output and would otherwise churn constantly.
 */
/** Dependencies the browser-automation live methods read/write. Kept as plain
 * getters/setters so the behavior is unit-testable without React. Notably there
 * is NO `activateTab` here — automation must never change the UI activeId. */
export type BrowserLiveDeps = {
  openTab: (url: string, activate: boolean) => number;
  closeTab: (tabId: number) => void;
  getActiveSpaceId: () => string;
  getTargetForSpace: (spaceId: string) => number | null;
  setTargetForSpace: (spaceId: string, id: number | null) => void;
  getTabs: () => Tab[];
  getActiveId: () => number;
  getBrowser: (id: number) => BrowserPaneHandle | undefined;
};

/** Resolve the automation target for the active workspace: the target recorded
 * for that space if it still points at a live browser tab, else the UI's active
 * tab if that is a browser (the active tab is always in the active space), else
 * null. Targeting is per-workspace so concurrent agents in different spaces do
 * not contend. */
export function resolveAutomationTarget(d: BrowserLiveDeps): number | null {
  const space = d.getActiveSpaceId();
  const tabs = d.getTabs();
  const target = d.getTargetForSpace(space);
  if (target != null && tabs.some((t) => t.id === target && t.kind === "browser")) {
    return target;
  }
  const activeId = d.getActiveId();
  const active = tabs.find((t) => t.id === activeId);
  return active?.kind === "browser" ? activeId : null;
}

/** Browser operations exposed to the AI agent. Automation owns a per-workspace
 * target, separate from the UI activeId, so opening/switching never steals focus
 * and agents in different spaces never contend. */
export function buildBrowserLive(d: BrowserLiveDeps) {
  return {
    openBrowser: (url: string) => {
      const id = d.openTab(url, false); // background: do not touch UI activeId
      d.setTargetForSpace(d.getActiveSpaceId(), id);
      return true;
    },
    navigateBrowser: (url: string) => {
      const target = resolveAutomationTarget(d);
      if (target == null) {
        const id = d.openTab(url, false);
        d.setTargetForSpace(d.getActiveSpaceId(), id);
        return true;
      }
      const browser = d.getBrowser(target);
      if (!browser) return false;
      browser.navigate(url);
      return true;
    },
    getActiveBrowserTabId: () => resolveAutomationTarget(d),
    switchBrowserTab: (tabId: number) => {
      const tab = d.getTabs().find((t) => t.id === tabId);
      if (tab?.kind !== "browser") return false;
      // Automation target only — deliberately NOT activating the UI tab.
      d.setTargetForSpace(d.getActiveSpaceId(), tabId);
      return true;
    },
    closeBrowserTab: (tabId: number) => {
      const tab = d.getTabs().find((t) => t.id === tabId);
      if (tab?.kind !== "browser") return false;
      d.closeTab(tabId);
      if (resolveAutomationTarget(d) === tabId) {
        d.setTargetForSpace(d.getActiveSpaceId(), null);
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
      ...buildBrowserLive({
        openTab: (url, activate) => ref.current.openBrowserTab(url, activate),
        closeTab: (tabId) => ref.current.closeTab(tabId),
        getActiveSpaceId: () => ref.current.activeSpaceId,
        getTargetForSpace: (space) => ref.current.activeBrowserTabIds[space] ?? null,
        setTargetForSpace: (space, id) => ref.current.setActiveBrowserTabId(space, id),
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
        const hooksReady = invoke("agent_enable_hooks", { agent: "claude" }).catch(
          () => {},
        );
        void (async () => {
          await Promise.all([whenSessionReady(leafId), hooksReady]);
          if (!writeToSession(leafId, "claude\r")) {
            useManagedAgentsStore.getState().remove(leafId);
            return;
          }
          const readBuf = () => {
            const term = terminalRefs.current.get(leafId);
            return term ? term.getBuffer(120) : null;
          };
          const result = await waitForClaudeTuiReady(readBuf);
          if (result !== "ready") {
            if (result === "timeout") {
              console.warn(
                "[anbo] Claude TUI did not appear in time; aborting prompt send",
              );
            }
            useManagedAgentsStore.getState().remove(leafId);
            return;
          }
          if (!writeToSession(leafId, `\x1b[200~${trimmed}\x1b[201~`)) {
            useManagedAgentsStore.getState().remove(leafId);
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
