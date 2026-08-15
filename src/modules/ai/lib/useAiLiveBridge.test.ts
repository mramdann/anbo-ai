import {
  clearBrowserAutomationActivity,
  getBrowserAutomationActivity,
} from "@/modules/browser/automationActivity";
import type { Tab } from "@/modules/tabs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type BrowserLiveDeps,
  buildBrowserLive,
  isClaudeTuiReady,
  resolveAutomationTarget,
  waitForClaudeTuiReady,
} from "./useAiLiveBridge";

const browserTab = (id: number, spaceId = "A"): Tab =>
  ({ id, kind: "browser", spaceId, title: "b", url: "https://x" }) as Tab;
const termTab = (id: number, spaceId = "A"): Tab =>
  ({ id, kind: "terminal", spaceId, title: "t" }) as unknown as Tab;

afterEach(() => {
  vi.useRealTimers();
  clearBrowserAutomationActivity(10);
  clearBrowserAutomationActivity(99);
});

describe("Claude TUI startup", () => {
  it("recognizes stable help text and the Claude prompt", () => {
    expect(isClaudeTuiReady("Press ? for shortcuts")).toBe(true);
    expect(isClaudeTuiReady("Claude Code\n\n❯ ")).toBe(true);
    expect(isClaudeTuiReady("PowerShell\nPS C:\\workspace>")).toBe(false);
  });

  it("waits while the terminal handle is not mounted yet", async () => {
    vi.useFakeTimers();
    let reads = 0;
    const result = waitForClaudeTuiReady(
      () => {
        reads += 1;
        return reads < 3 ? null : "? for shortcuts";
      },
      1_000,
      10,
    );

    await vi.advanceTimersByTimeAsync(30);

    await expect(result).resolves.toBe("ready");
  });
});

function makeDeps(
  over: {
    tabs?: Tab[];
    activeId?: number;
    activeSpace?: string;
    targets?: Record<string, number | null>;
    openTab?: BrowserLiveDeps["openTab"];
    closeTab?: BrowserLiveDeps["closeTab"];
    setTargetForSpace?: BrowserLiveDeps["setTargetForSpace"];
    getBrowser?: BrowserLiveDeps["getBrowser"];
  } = {},
): BrowserLiveDeps {
  const targets = { ...(over.targets ?? {}) };
  return {
    openTab: over.openTab ?? vi.fn(() => 0),
    closeTab: over.closeTab ?? vi.fn(),
    getActiveSpaceId: () => over.activeSpace ?? "A",
    getTargetForSpace: (spaceId) => targets[spaceId] ?? null,
    setTargetForSpace: over.setTargetForSpace ?? vi.fn(),
    getTabs: () => over.tabs ?? [browserTab(10), browserTab(11)],
    getActiveId: () => over.activeId ?? 1,
    getBrowser: over.getBrowser ?? (() => undefined),
  };
}

describe("buildBrowserLive", () => {
  it("opens a background tab in the requested workspace", () => {
    const openTab = vi.fn(() => 99);
    const setTargetForSpace = vi.fn();
    const live = buildBrowserLive(
      makeDeps({ openTab, setTargetForSpace, activeSpace: "B", tabs: [] }),
    );

    expect(live.openBrowser("https://example.com", "A")).toBe(true);
    expect(openTab).toHaveBeenCalledWith("https://example.com", false, "A");
    expect(setTargetForSpace).toHaveBeenCalledWith("A", 99);
    expect(getBrowserAutomationActivity(99)).toBe("open");
  });

  it("keeps tab switching scoped and never accepts a tab from another workspace", () => {
    const setTargetForSpace = vi.fn();
    const live = buildBrowserLive(
      makeDeps({
        setTargetForSpace,
        tabs: [browserTab(10, "A"), browserTab(11, "B"), termTab(12)],
      }),
    );

    expect(live.switchBrowserTab(10, "A")).toBe(true);
    expect(setTargetForSpace).toHaveBeenCalledWith("A", 10);
    expect(live.switchBrowserTab(11, "A")).toBe(false);
    expect(live.switchBrowserTab(12, "A")).toBe(false);
  });

  it("resolves each workspace target without contention", () => {
    const tabs = [browserTab(10, "A"), browserTab(11, "B")];
    const deps = makeDeps({ tabs, targets: { A: 10, B: 11 } });

    expect(resolveAutomationTarget(deps, "A")).toBe(10);
    expect(resolveAutomationTarget(deps, "B")).toBe(11);
  });

  it("navigates the target from the requested workspace", () => {
    const navigate = vi.fn();
    const live = buildBrowserLive(
      makeDeps({
        activeSpace: "B",
        tabs: [browserTab(10, "A"), browserTab(11, "B")],
        targets: { A: 10, B: 11 },
        getBrowser: (id) =>
          id === 10 ? ({ navigate } as unknown as never) : undefined,
      }),
    );

    expect(live.navigateBrowser("https://example.com/docs", "A")).toBe(true);
    expect(navigate).toHaveBeenCalledWith("https://example.com/docs");
    expect(getBrowserAutomationActivity(10)).toBe("navigate");
  });

  it("closes only tabs owned by the requested workspace", () => {
    const closeTab = vi.fn();
    const setTargetForSpace = vi.fn();
    const live = buildBrowserLive(
      makeDeps({
        closeTab,
        setTargetForSpace,
        targets: { A: 10 },
        tabs: [browserTab(10, "A"), browserTab(11, "B")],
      }),
    );

    expect(live.closeBrowserTab(11, "A")).toBe(false);
    expect(live.closeBrowserTab(10, "A")).toBe(true);
    expect(closeTab).toHaveBeenCalledWith(10);
    expect(setTargetForSpace).toHaveBeenCalledWith("A", null);
  });
});

describe("resolveAutomationTarget", () => {
  it("falls back only to an active browser in the requested workspace", () => {
    const tabs = [browserTab(10, "A"), browserTab(11, "B"), termTab(12)];

    expect(
      resolveAutomationTarget(
        makeDeps({ tabs, targets: { A: 99 }, activeId: 10 }),
        "A",
      ),
    ).toBe(10);
    expect(
      resolveAutomationTarget(
        makeDeps({ tabs, targets: { A: 99 }, activeId: 11 }),
        "A",
      ),
    ).toBeNull();
    expect(
      resolveAutomationTarget(makeDeps({ tabs, activeId: 12 }), "A"),
    ).toBeNull();
  });

  it("rejects a recorded target that belongs to another workspace", () => {
    const tabs = [browserTab(10, "A"), browserTab(11, "B")];
    const deps = makeDeps({ tabs, targets: { A: 11 }, activeId: 11 });

    expect(resolveAutomationTarget(deps, "A")).toBeNull();
  });
});
