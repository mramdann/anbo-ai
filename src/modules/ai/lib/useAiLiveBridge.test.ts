import { describe, expect, it, vi } from "vitest";
import type { Tab } from "@/modules/tabs";
import {
  buildBrowserLive,
  resolveAutomationTarget,
  type BrowserLiveDeps,
} from "./useAiLiveBridge";

const browserTab = (id: number): Tab =>
  ({ id, kind: "browser", title: "b", url: "https://x" }) as unknown as Tab;
const termTab = (id: number): Tab =>
  ({ id, kind: "terminal", title: "t" }) as unknown as Tab;

function makeDeps(
  over: {
    tabs?: Tab[];
    activeId?: number;
    activeSpace?: string;
    targets?: Record<string, number | null>;
    openTab?: BrowserLiveDeps["openTab"];
    closeTab?: BrowserLiveDeps["closeTab"];
    setTargetForSpace?: BrowserLiveDeps["setTargetForSpace"];
  } = {},
): BrowserLiveDeps {
  const targets = { ...(over.targets ?? {}) };
  return {
    openTab: over.openTab ?? vi.fn(() => 0),
    closeTab: over.closeTab ?? vi.fn(),
    getActiveSpaceId: () => over.activeSpace ?? "space-a",
    getTargetForSpace: (s) => targets[s] ?? null,
    setTargetForSpace: over.setTargetForSpace ?? vi.fn(),
    getTabs: () => over.tabs ?? [browserTab(10), browserTab(11)],
    getActiveId: () => over.activeId ?? 1,
    getBrowser: () => undefined,
  };
}

describe("buildBrowserLive — per-workspace target, no UI focus steal", () => {
  it("openBrowser opens in the background (activate=false) and targets it in the active space", () => {
    const openTab = vi.fn(() => 99);
    const setTargetForSpace = vi.fn();
    const live = buildBrowserLive(
      makeDeps({ openTab, setTargetForSpace, activeSpace: "A", tabs: [] }),
    );

    expect(live.openBrowser("https://example.com")).toBe(true);
    expect(openTab).toHaveBeenCalledWith("https://example.com", false);
    expect(setTargetForSpace).toHaveBeenCalledWith("A", 99);
  });

  it("switchBrowserTab sets the target only for the active space and never activates the UI", () => {
    const setTargetForSpace = vi.fn();
    const live = buildBrowserLive(
      makeDeps({
        setTargetForSpace,
        activeSpace: "A",
        tabs: [browserTab(10), termTab(12)],
      }),
    );

    expect(live.switchBrowserTab(10)).toBe(true);
    expect(setTargetForSpace).toHaveBeenCalledWith("A", 10);
    // switching to a non-browser tab id is rejected
    expect(live.switchBrowserTab(12)).toBe(false);
  });

  it("per-workspace isolation: each space resolves its own target with no contention", () => {
    const tabs = [browserTab(10), browserTab(11)];
    const spaceA = makeDeps({ tabs, activeSpace: "A", targets: { A: 10, B: 11 } });
    const spaceB = makeDeps({ tabs, activeSpace: "B", targets: { A: 10, B: 11 } });

    expect(resolveAutomationTarget(spaceA)).toBe(10);
    expect(resolveAutomationTarget(spaceB)).toBe(11);

    // an agent in space B opening a tab targets B, never A
    const setB = vi.fn();
    const liveB = buildBrowserLive(
      makeDeps({
        tabs,
        activeSpace: "B",
        openTab: vi.fn(() => 77),
        setTargetForSpace: setB,
      }),
    );
    liveB.openBrowser("https://y");
    expect(setB).toHaveBeenCalledWith("B", 77);
    expect(setB).not.toHaveBeenCalledWith("A", expect.anything());
  });

  it("getActiveBrowserTabId: target wins; stale target falls back to UI active browser; else null", () => {
    const tabs = [browserTab(10), browserTab(11), termTab(12)];
    expect(
      buildBrowserLive(makeDeps({ tabs, activeSpace: "A", targets: { A: 11 } })).getActiveBrowserTabId(),
    ).toBe(11);
    expect(
      buildBrowserLive(
        makeDeps({ tabs, activeSpace: "A", targets: { A: 99 }, activeId: 10 }),
      ).getActiveBrowserTabId(),
    ).toBe(10); // stale target -> UI active browser
    expect(
      buildBrowserLive(
        makeDeps({ tabs, activeSpace: "A", targets: {}, activeId: 12 }),
      ).getActiveBrowserTabId(),
    ).toBeNull(); // UI active is a terminal -> null
  });

  it("closeBrowserTab closes the tab and clears the active space's target when it was the target", () => {
    const closeTab = vi.fn();
    const setTargetForSpace = vi.fn();
    const live = buildBrowserLive(
      makeDeps({
        closeTab,
        setTargetForSpace,
        activeSpace: "A",
        targets: { A: 10 },
        tabs: [browserTab(10)],
      }),
    );

    expect(live.closeBrowserTab(10)).toBe(true);
    expect(closeTab).toHaveBeenCalledWith(10);
    expect(setTargetForSpace).toHaveBeenCalledWith("A", null);
    expect(live.closeBrowserTab(77)).toBe(false); // unknown id rejected
  });
});

describe("resolveAutomationTarget", () => {
  const tabs = [browserTab(10), browserTab(11), termTab(12)];

  it("prefers the active space's target when it is a live browser tab", () => {
    expect(
      resolveAutomationTarget(makeDeps({ tabs, activeSpace: "A", targets: { A: 11 } })),
    ).toBe(11);
  });

  it("falls back to the UI active browser tab when the target is stale or unset", () => {
    expect(
      resolveAutomationTarget(
        makeDeps({ tabs, activeSpace: "A", targets: { A: 99 }, activeId: 10 }),
      ),
    ).toBe(10);
    expect(
      resolveAutomationTarget(makeDeps({ tabs, activeSpace: "A", targets: {}, activeId: 10 })),
    ).toBe(10);
  });

  it("returns null when neither target nor UI active tab is a browser", () => {
    expect(
      resolveAutomationTarget(makeDeps({ tabs, activeSpace: "A", targets: {}, activeId: 12 })),
    ).toBeNull();
  });
});
