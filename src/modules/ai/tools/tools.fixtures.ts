import type { ToolExecutionOptions } from "ai";
import type { ToolContext } from "./context";

/**
 * The options the SDK hands a tool's execute. Our tools declare no context
 * schema, so they get the default context: an empty record.
 */
export const toolOptions: ToolExecutionOptions<Record<string, unknown>> = {
  toolCallId: "tool-call",
  messages: [],
  context: {},
};

/** A tool context with nothing attached; a test overrides what it exercises. */
export function makeToolContext(
  overrides: Partial<ToolContext> = {},
): ToolContext {
  return {
    getCwd: () => "/workspace",
    getWorkspaceRoot: () => "/workspace",
    getWorkspaceEnv: () => ({ kind: "local" }),
    getTerminalContext: () => null,
    isActiveTerminalPrivate: () => false,
    injectIntoActivePty: () => false,
    openBrowser: () => false,
    navigateBrowser: () => false,
    getActiveBrowserTabId: () => null,
    switchBrowserTab: () => false,
    closeBrowserTab: () => false,
    spawnAgent: () => null,
    readAgentOutput: () => null,
    readCache: new Map(),
    getSessionId: () => "session",
    ...overrides,
  };
}
