import { describe, expect, it } from "vitest";
import {
  applyTabOpen,
  type EditorTab,
  onceId,
  planAiDiffOpen,
  planFileOpen,
  planMarkdownOpen,
  type Tab,
} from "./useTabs";

function terminal(id: number, spaceId = "default"): Tab {
  return {
    id,
    kind: "terminal",
    spaceId,
    title: "shell",
    paneTree: { kind: "leaf", id: id * 10 },
    activeLeafId: id * 10,
  };
}

function editor(id: number, path: string, preview: boolean): EditorTab {
  return {
    id,
    kind: "editor",
    spaceId: "default",
    title: path,
    path,
    dirty: false,
    preview,
  };
}

/**
 * Stands in for React's two useState hooks. `deferred` holds updaters until
 * the next render, as React does while the component has a pending update,
 * and a render runs them in hook order: tabs before `activeId`.
 */
function hookState(tabs: Tab[], activeId: number, deferred: boolean) {
  const state = { tabs, activeId };
  const tabUpdates: ((tabs: Tab[]) => Tab[])[] = [];
  const activeUpdates: ((id: number) => number)[] = [];
  return {
    state,
    tabsRef: { current: tabs },
    setTabs(update: (tabs: Tab[]) => Tab[]) {
      if (deferred) tabUpdates.push(update);
      else state.tabs = update(state.tabs);
    },
    setActiveId(update: (id: number) => number) {
      if (deferred) activeUpdates.push(update);
      else state.activeId = update(state.activeId);
    },
    render() {
      for (const update of tabUpdates.splice(0))
        state.tabs = update(state.tabs);
      for (const update of activeUpdates.splice(0)) {
        state.activeId = update(state.activeId);
      }
    },
  };
}

describe("applyTabOpen", () => {
  for (const deferred of [false, true]) {
    it(`activates a new tab when React runs updaters ${deferred ? "later" : "at once"}`, () => {
      // Deferred is the case that broke: a file opened after the window came
      // back from minimized was added but stayed behind the current tab.
      const hook = hookState([terminal(1)], 1, deferred);
      const allocId = onceId({ current: 7 });
      const id = applyTabOpen(
        (tabs) => planMarkdownOpen(tabs, "D:/notes/a.md", "default", allocId),
        hook.tabsRef,
        hook.setTabs,
        hook.setActiveId,
      );
      hook.render();
      expect(id).toBe(7);
      expect(hook.state.activeId).toBe(7);
      expect(hook.state.tabs.map((tab) => tab.id)).toEqual([1, 7]);
      expect(hook.tabsRef.current.map((tab) => tab.id)).toEqual([1, 7]);
    });
  }

  it("follows the updater when a pending update already opened the path", () => {
    // The tabs the hook knows lack a tab a queued update adds; the updater
    // finds it, so that tab is activated rather than an id never created.
    const hook = hookState([terminal(1)], 1, true);
    hook.setTabs((tabs) => [
      ...tabs,
      { id: 4, kind: "markdown", spaceId: "default", title: "a.md", path: "a" },
    ]);
    const allocId = onceId({ current: 9 });
    applyTabOpen(
      (tabs) => planMarkdownOpen(tabs, "a", "default", allocId),
      hook.tabsRef,
      hook.setTabs,
      hook.setActiveId,
    );
    hook.render();
    expect(hook.state.activeId).toBe(4);
    expect(hook.state.tabs.map((tab) => tab.id)).toEqual([1, 4]);
  });

  it("opens one tab for two opens of a path before a render", () => {
    const hook = hookState([terminal(1)], 1, true);
    const allocator = { current: 5 };
    const open = () => {
      const allocId = onceId(allocator);
      return applyTabOpen(
        (tabs) => planFileOpen(tabs, "b.ts", true, "default", allocId),
        hook.tabsRef,
        hook.setTabs,
        hook.setActiveId,
      );
    };
    expect([open(), open()]).toEqual([5, 5]);
    hook.render();
    expect(hook.state.tabs.map((tab) => tab.id)).toEqual([1, 5]);
    expect(hook.state.activeId).toBe(5);
  });
});

describe("onceId", () => {
  it("keeps one id however often a plan runs", () => {
    const allocator = { current: 3 };
    const allocId = onceId(allocator);
    expect([allocId(), allocId()]).toEqual([3, 3]);
    expect(onceId(allocator)()).toBe(4);
  });
});

describe("planFileOpen", () => {
  const next = () => 20;

  it("pins a preview tab of the path in place", () => {
    const plan = planFileOpen(
      [editor(2, "a.ts", true)],
      "a.ts",
      true,
      "default",
      next,
    );
    expect(plan.targetId).toBe(2);
    expect(plan.tabs).toEqual([editor(2, "a.ts", false)]);
  });

  it("keeps a persistent tab of the path for a preview open", () => {
    const tabs = [editor(2, "a.ts", false)];
    expect(planFileOpen(tabs, "a.ts", false, "default", next)).toEqual({
      tabs,
      targetId: 2,
    });
  });

  it("takes the preview slot for a new preview path", () => {
    const plan = planFileOpen(
      [terminal(1), editor(2, "a.ts", true)],
      "b.ts",
      false,
      "default",
      next,
    );
    expect(plan.targetId).toBe(20);
    expect(plan.tabs.map((tab) => tab.id)).toEqual([1, 20]);
    expect(plan.tabs[1]).toMatchObject({ path: "b.ts", preview: true });
  });

  it("appends a persistent tab in the given space", () => {
    const plan = planFileOpen([terminal(1)], "c.ts", true, "sp-2", next);
    expect(plan.tabs[1]).toMatchObject({
      id: 20,
      kind: "editor",
      spaceId: "sp-2",
      preview: false,
    });
  });
});

describe("planAiDiffOpen", () => {
  it("reuses the tab of an approval", () => {
    const input = {
      path: "D:/p/a.ts",
      originalContent: "",
      proposedContent: "x",
      approvalId: "ap-1",
      isNewFile: true,
    };
    const first = planAiDiffOpen([], input, "default", () => 11);
    expect(first.tabs[0]).toMatchObject({
      title: "a.ts (AI diff)",
      status: "pending",
    });
    const again = planAiDiffOpen(first.tabs, input, "default", () => 12);
    expect(again).toEqual({ tabs: first.tabs, targetId: 11 });
  });
});
