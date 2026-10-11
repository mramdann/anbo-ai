import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SerializedDockview } from "dockview-react";
import { describe, expect, it } from "vitest";
import { DOCK_TAB_STRIP_PX, groupContentStyle } from "./dockContentArea";
import {
  savedBackgroundAreas,
  savedGroupAreas,
  savedTabGroupArea,
} from "./savedDockArea";
import type { BrowserTab, Tab } from "./useTabs";

type Leaf = { group: string; tabs: number[]; size: number; visible?: boolean };
type Branch = { children: Array<Leaf | Branch>; size: number };

function node(item: Leaf | Branch): unknown {
  if ("group" in item) {
    return {
      type: "leaf",
      size: item.size,
      ...(item.visible === false && { visible: false }),
      data: { id: item.group, views: item.tabs.map((id) => `tab:${id}`) },
    };
  }
  return { type: "branch", size: item.size, data: item.children.map(node) };
}

// A saved layout as readWorkspaceDockviewLayout hands it back, reduced to
// what the boxes are read from.
function layout(
  children: Array<Leaf | Branch>,
  options: {
    orientation?: "HORIZONTAL" | "VERTICAL";
    activeGroup?: string;
  } = {},
): SerializedDockview {
  return {
    grid: {
      root: { type: "branch", size: 600, data: children.map(node) },
      width: 1000,
      height: 600,
      orientation: options.orientation ?? "HORIZONTAL",
    },
    panels: {},
    activeGroup: options.activeGroup,
  } as unknown as SerializedDockview;
}

const browser = (id: number, spaceId = "b"): BrowserTab =>
  ({
    id,
    kind: "browser",
    spaceId,
    title: "",
    url: "https://x.test",
  }) as BrowserTab;
const terminal = (id: number, spaceId = "b"): Tab =>
  ({ id, kind: "terminal", spaceId }) as Tab;

describe("savedGroupAreas", () => {
  it("gives every group its share of the dock, nested splits included", () => {
    const areas = savedGroupAreas(
      layout([
        { group: "left", tabs: [1], size: 400 },
        {
          size: 600,
          children: [
            { group: "top", tabs: [2], size: 150 },
            { group: "gone", tabs: [], size: 50, visible: false },
            { group: "bottom", tabs: [3], size: 450 },
          ],
        },
      ]),
    );
    expect(areas.map(({ id, area }) => ({ id, ...area }))).toEqual([
      { id: "left", top: 0, left: 0, width: 0.4, height: 1 },
      { id: "top", top: 0, left: 0.4, width: 0.6, height: 0.25 },
      { id: "bottom", top: 0.25, left: 0.4, width: 0.6, height: 0.75 },
    ]);
  });

  it("reads a dock split top and bottom", () => {
    const areas = savedGroupAreas(
      layout(
        [
          { group: "top", tabs: [1], size: 200 },
          { group: "bottom", tabs: [2], size: 400 },
        ],
        { orientation: "VERTICAL" },
      ),
    );
    expect(areas[1].area).toEqual({
      top: 1 / 3,
      left: 0,
      width: 1,
      height: 2 / 3,
    });
  });
});

describe("savedTabGroupArea", () => {
  const split = layout(
    [
      { group: "work", tabs: [1, 2], size: 400 },
      { group: "pages", tabs: [3], size: 600 },
    ],
    { activeGroup: "work" },
  );
  const tabs = [terminal(1), terminal(2), browser(3), browser(4)];

  it("is the tab's own group when the saved layout holds it", () => {
    expect(savedTabGroupArea(split, tabs, browser(3), null)?.left).toBe(0.4);
  });

  it("puts a tab the layout does not hold in a tidy layout's browser panel", () => {
    expect(savedTabGroupArea(split, tabs, browser(4), "right")).toEqual({
      top: 0,
      left: 0.4,
      width: 0.6,
      height: 1,
    });
  });

  it("opens a browser panel along the tidy side when there is none", () => {
    const agentsOnly = layout([{ group: "work", tabs: [1, 2], size: 1000 }]);
    expect(
      savedTabGroupArea(
        agentsOnly,
        [...tabs.slice(0, 2), browser(4)],
        browser(4),
        "left",
      ),
    ).toEqual({ top: 0, left: 0, width: 0.6, height: 1 });
  });

  it("counts a browser panel left empty as the panel", () => {
    const emptied = layout([
      { group: "work", tabs: [1, 2], size: 400 },
      { group: "panel", tabs: [], size: 600 },
    ]);
    expect(savedTabGroupArea(emptied, tabs, browser(4), "right")?.left).toBe(
      0.4,
    );
  });

  it("puts it beside its neighbour in a free layout, else in the group last in use", () => {
    // Tab 4 follows tab 3, which is in the right-hand group.
    expect(savedTabGroupArea(split, tabs, browser(4), null)?.left).toBe(0.4);
    // A tab first in the order takes the group of the tab after it.
    expect(
      savedTabGroupArea(split, [browser(5), ...tabs], browser(5), null)?.left,
    ).toBe(0);
    // With no neighbour placed at all, the group last in use.
    expect(
      savedTabGroupArea(
        layout(
          [
            { group: "a", tabs: [], size: 500 },
            { group: "b", tabs: [], size: 500 },
          ],
          { activeGroup: "b" },
        ),
        [browser(6)],
        browser(6),
        null,
      )?.left,
    ).toBe(0.5);
  });
});

describe("savedBackgroundAreas", () => {
  const shownTab = browser(10, "shown");
  const chrome = {
    ...browser(11),
    external: { browser: "chrome" },
  } as unknown as BrowserTab;
  const unsaved = browser(12, "c");
  const placed = browser(3);
  const tabs = [terminal(1), terminal(2), placed, shownTab, chrome, unsaved];
  const saved = (spaceId: string) =>
    spaceId === "b"
      ? layout([
          { group: "work", tabs: [1, 2], size: 400 },
          { group: "pages", tabs: [3], size: 600 },
        ])
      : spaceId === "shown"
        ? layout([{ group: "only", tabs: [10], size: 1000 }])
        : null;

  it("covers hidden embedded tabs of the workspaces not in view only", () => {
    const asked: string[] = [];
    const areas = savedBackgroundAreas({
      hidden: [shownTab, chrome, unsaved, placed],
      tabs,
      followingSpaceId: "shown",
      sideOf: () => null,
      layoutOf: (spaceId, spaceTabs) => {
        asked.push(`${spaceId}:${spaceTabs.map((tab) => tab.id).join(",")}`);
        return saved(spaceId);
      },
    });
    expect([...areas.keys()]).toEqual([3]);
    expect(areas.get(3)?.left).toBe(0.4);
    // One read per workspace, with that workspace's tabs.
    expect(asked).toEqual(["c:12", "b:1,2,3,11"]);
  });

  it("covers the workspace in view too while the host has another one's box", () => {
    // Right after a switch the host still has the box of the workspace shown
    // before; following it would move the page there and back.
    const areas = savedBackgroundAreas({
      hidden: [shownTab, placed],
      tabs,
      followingSpaceId: null,
      sideOf: () => null,
      layoutOf: (spaceId) => saved(spaceId),
    });
    expect([...areas.keys()].sort((a, b) => a - b)).toEqual([3, 10]);
    expect(areas.get(10)).toEqual({ top: 0, left: 0, width: 1, height: 1 });
  });
});

describe("groupContentStyle", () => {
  it("places a pane over a group's content from inside the hidden host", () => {
    // The host covers the right 60% of the dock below its strip; the group
    // is the left 40%, strip included.
    expect(
      groupContentStyle(
        { top: 0, left: 0, width: 0.4, height: 1 },
        { top: 0.05, left: 0.4, width: 0.6, height: 0.95 },
        DOCK_TAB_STRIP_PX,
      ),
    ).toEqual({
      top: `calc(${(-0.05 / 0.95) * 100}% + 32px)`,
      left: `${(-0.4 / 0.6) * 100}%`,
      width: `${(0.4 / 0.6) * 100}%`,
      height: `calc(${(1 / 0.95) * 100}% - 32px)`,
    });
  });

  it("uses the whole dock without a host and no strip in zen mode", () => {
    expect(
      groupContentStyle({ top: 0, left: 0.5, width: 0.5, height: 1 }, null, 0),
    ).toEqual({ top: "0%", left: "50%", width: "50%", height: "100%" });
  });

  it("keeps the strip height the dock's stylesheet gives the tab strip", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const css = readFileSync(
      path.join(here, "..", "WorkspaceDockview.css"),
      "utf8",
    );
    expect(css).toContain(
      `--dv-tabs-and-actions-container-height: ${DOCK_TAB_STRIP_PX}px;`,
    );
  });
});
