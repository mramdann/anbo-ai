import { describe, expect, it } from "vitest";
import type { BrowserTab, Tab } from "@/modules/tabs";
import {
  browserPaneInitialLoading,
  followsHostSize,
  selectBackgroundBrowserTabs,
} from "./BrowserStack";

const tab = (id: number, kind: Tab["kind"], spaceId: string) =>
  ({ id, kind, spaceId }) as Tab;

describe("followsHostSize", () => {
  it("lets only a hidden tab of the space in view follow its box", () => {
    const inView = tab(1, "browser", "A") as BrowserTab;
    const elsewhere = tab(2, "browser", "B") as BrowserTab;
    expect(followsHostSize(inView, false, "A")).toBe(true);
    // A tab of another space keeps its size until its own space is shown.
    expect(followsHostSize(elsewhere, false, "A")).toBe(false);
    // A visible pane already follows its box; no space named, nothing follows.
    expect(followsHostSize(inView, true, "A")).toBe(false);
    expect(followsHostSize(inView, false, null)).toBe(false);
  });
});

describe("selectBackgroundBrowserTabs", () => {
  it("hosts only tabs without a visible dockview panel", () => {
    const tabs = [
      tab(1, "browser", "A"),
      tab(2, "browser", "B"),
      tab(3, "terminal", "B"),
      tab(4, "browser", "C"),
    ];

    expect(
      selectBackgroundBrowserTabs(tabs, new Set([1])).map((item) => item.id),
    ).toEqual([2, 4]);
  });

  it("leaves a visible browser with its dockview owner", () => {
    const tabs = [tab(1, "terminal", "A"), tab(2, "browser", "A")];

    expect(selectBackgroundBrowserTabs(tabs, new Set([2]))).toEqual([]);
  });

  it("hosts inactive panels even when they share the active workspace", () => {
    const tabs = [
      tab(1, "browser", "A"),
      tab(2, "browser", "A"),
      tab(3, "browser", "A"),
    ];

    expect(
      selectBackgroundBrowserTabs(tabs, new Set([2])).map((item) => item.id),
    ).toEqual([1, 3]);
  });

  it("keeps one automation target alive for each of ten workspaces", () => {
    const tabs = Array.from({ length: 10 }, (_, index) =>
      tab(index + 1, "browser", `space-${index + 1}`),
    );
    expect(
      selectBackgroundBrowserTabs(tabs, new Set()).map((item) => item.id),
    ).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("does not mount a warm tab twice during an active-tab transition", () => {
    const tabs = [tab(1, "browser", "A"), tab(2, "browser", "B")];
    expect(
      selectBackgroundBrowserTabs(tabs, new Set([2])).map((item) => item.id),
    ).toEqual([1]);
  });

  it("excludes every visible browser in a split layout", () => {
    const tabs = [
      tab(1, "browser", "A"),
      tab(2, "browser", "A"),
      tab(3, "browser", "B"),
    ];
    expect(
      selectBackgroundBrowserTabs(tabs, new Set([1, 2])).map(
        (item) => item.id,
      ),
    ).toEqual([3]);
  });
});

describe("browserPaneInitialLoading", () => {
  it("preserves a completed page across workspace host handoffs", () => {
    expect(
      browserPaneInitialLoading({
        ...tab(1, "browser", "A"),
        kind: "browser",
        title: "Example",
        url: "https://example.com",
        loading: false,
      }),
    ).toBe(false);
  });

  it("shows loading for a newly created URL until navigation reports completion", () => {
    expect(
      browserPaneInitialLoading({
        ...tab(1, "browser", "A"),
        kind: "browser",
        title: "Example",
        url: "https://example.com",
      }),
    ).toBe(true);
  });
});
