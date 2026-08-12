import { describe, expect, it, vi } from "vitest";
import type { Live } from "../store/chatStore";
import {
  createRunToolContext,
  selectRunSnapshot,
  type LiveSnapshot,
} from "./runContext";

function makeSnapshot(): LiveSnapshot {
  return {
    cwd: "C:\\workspaces\\alpha",
    terminalPrivate: false,
    workspaceRoot: "C:\\workspaces\\alpha",
    workspaceEnv: { kind: "local" },
    activeFile: null,
    spaceId: "alpha",
  };
}

describe("createRunToolContext", () => {
  it("keeps browser operations scoped to the workspace where the run started", () => {
    let foregroundSpace = "alpha";
    const openBrowser = vi.fn(() => true);
    const navigateBrowser = vi.fn(() => true);
    const switchBrowserTab = vi.fn(() => true);
    const live = {
      getActiveSpaceId: () => foregroundSpace,
      getTerminalContext: vi.fn(() => "alpha output"),
      openBrowser,
      navigateBrowser,
      getActiveBrowserTabId: vi.fn(() => 17),
      switchBrowserTab,
      closeBrowserTab: vi.fn(() => true),
      injectIntoActivePty: vi.fn(() => true),
      spawnManagedAgent: vi.fn(() => null),
      readLeafBuffer: vi.fn(() => null),
    } as unknown as Live;
    const context = createRunToolContext(
      () => live,
      makeSnapshot(),
      new Map(),
      "session-1",
    );

    foregroundSpace = "beta";
    expect(context.openBrowser("https://example.com")).toBe(true);
    expect(context.navigateBrowser("https://example.com/docs")).toBe(true);
    expect(context.switchBrowserTab(17)).toBe(true);
    expect(openBrowser).toHaveBeenCalledWith("https://example.com", "alpha");
    expect(navigateBrowser).toHaveBeenCalledWith(
      "https://example.com/docs",
      "alpha",
    );
    expect(switchBrowserTab).toHaveBeenCalledWith(17, "alpha");
  });

  it("freezes filesystem context and refuses terminal injection after a workspace switch", () => {
    let foregroundSpace = "alpha";
    const injectIntoActivePty = vi.fn(() => true);
    const spawnManagedAgent = vi.fn(() => null);
    const live = {
      getActiveSpaceId: () => foregroundSpace,
      injectIntoActivePty,
      spawnManagedAgent,
      readLeafBuffer: vi.fn(() => null),
    } as unknown as Live;
    const snapshot = makeSnapshot();
    const context = createRunToolContext(
      () => live,
      snapshot,
      new Map(),
      "session-1",
    );

    foregroundSpace = "beta";
    expect(context.getCwd()).toBe(snapshot.cwd);
    expect(context.getWorkspaceRoot()).toBe(snapshot.workspaceRoot);
    expect(context.getWorkspaceEnv()).toBe(snapshot.workspaceEnv);
    expect(context.getTerminalContext()).toBeNull();
    expect(context.injectIntoActivePty("pwd")).toBe(false);
    expect(injectIntoActivePty).not.toHaveBeenCalled();
    expect(context.spawnAgent("continue")).toBeNull();
    expect(spawnManagedAgent).not.toHaveBeenCalled();
  });

  it("keeps one snapshot through continuations and resets for a new user message", () => {
    const first = makeSnapshot();
    const second = { ...first, spaceId: "beta" };
    const capture = vi.fn(() => second);

    expect(selectRunSnapshot(first, "assistant", capture)).toBe(first);
    expect(capture).not.toHaveBeenCalled();
    expect(selectRunSnapshot(first, "user", capture)).toBe(second);
    expect(capture).toHaveBeenCalledOnce();
  });
});
