import type { Live } from "../store/chatStore";
import type { ToolContext } from "../tools/tools";
import type { WorkspaceEnv } from "@/modules/workspace";

export type LiveSnapshot = {
  cwd: string | null;
  terminalPrivate: boolean;
  workspaceRoot: string | null;
  workspaceEnv: WorkspaceEnv;
  activeFile: string | null;
  spaceId: string;
};

type ReadCache = Map<string, { size: number; hash: number }>;

export function createRunToolContext(
  getLive: () => Live,
  snapshot: LiveSnapshot,
  readCache: ReadCache,
  sessionId: string,
  abortSignal?: AbortSignal,
): ToolContext {
  return {
    getCwd: () => snapshot.cwd,
    getWorkspaceRoot: () => snapshot.workspaceRoot,
    getWorkspaceEnv: () => snapshot.workspaceEnv,
    getTerminalContext: () => {
      const live = getLive();
      if (live.getActiveSpaceId() !== snapshot.spaceId) return null;
      return live.getTerminalContext();
    },
    isActiveTerminalPrivate: () => snapshot.terminalPrivate,
    injectIntoActivePty: (text) => {
      const live = getLive();
      if (live.getActiveSpaceId() !== snapshot.spaceId) return false;
      return live.injectIntoActivePty(text);
    },
    openBrowser: (url) => getLive().openBrowser(url, snapshot.spaceId),
    navigateBrowser: (url) => getLive().navigateBrowser(url, snapshot.spaceId),
    getActiveBrowserTabId: () =>
      getLive().getActiveBrowserTabId(snapshot.spaceId),
    switchBrowserTab: (tabId) =>
      getLive().switchBrowserTab(tabId, snapshot.spaceId),
    closeBrowserTab: (tabId) =>
      getLive().closeBrowserTab(tabId, snapshot.spaceId),
    spawnAgent: (prompt) => {
      const live = getLive();
      if (live.getActiveSpaceId() !== snapshot.spaceId) return null;
      return live.spawnManagedAgent(prompt, sessionId);
    },
    readAgentOutput: (leafId) => getLive().readLeafBuffer(leafId),
    readCache,
    getSessionId: () => sessionId,
    getAbortSignal: () => abortSignal,
  };
}

export function selectRunSnapshot(
  current: LiveSnapshot | null,
  lastMessageRole: string | undefined,
  capture: () => LiveSnapshot,
): LiveSnapshot {
  if (current && lastMessageRole !== "user") return current;
  return capture();
}
