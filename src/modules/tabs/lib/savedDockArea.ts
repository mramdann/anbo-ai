import type { SerializedDockview } from "dockview-react";
import type { DockArea } from "./dockContentArea";
import type { BrowserTab, Tab } from "./useTabs";
import { workspaceDockviewPanelId } from "./workspaceDockviewLayout";
import {
  BROWSER_PANEL_SHARE,
  type PanelSide,
  pickBrowserGroup,
} from "./workspaceTidyLayout";

/** A group of a saved layout and its box, each side a share of the dock. */
type SavedGroup = { id: string; views: readonly string[]; area: DockArea };

type GridNode = {
  type?: unknown;
  data?: unknown;
  size?: unknown;
  visible?: unknown;
};

function nodeSize(node: GridNode): number {
  return typeof node.size === "number" && node.size > 0 ? node.size : 0;
}

/** Every group of a saved layout with its box. Dockview scales a restored
 *  grid to the dock it lays out in, so shares of the saved grid are shares
 *  of the dock whatever its size is now. */
export function savedGroupAreas(layout: SerializedDockview): SavedGroup[] {
  const groups: SavedGroup[] = [];
  const walk = (node: GridNode, area: DockArea, horizontal: boolean) => {
    if (node.type === "leaf") {
      const group = node.data as { id?: unknown; views?: unknown } | null;
      if (typeof group?.id !== "string") return;
      const views = Array.isArray(group.views)
        ? group.views.filter((view): view is string => typeof view === "string")
        : [];
      groups.push({ id: group.id, views, area });
      return;
    }
    if (node.type !== "branch" || !Array.isArray(node.data)) return;
    const children = (node.data as GridNode[]).filter(
      (child) => child.visible !== false,
    );
    const total = children.reduce((sum, child) => sum + nodeSize(child), 0);
    if (total <= 0) return;
    let offset = 0;
    for (const child of children) {
      const share = nodeSize(child) / total;
      walk(
        child,
        horizontal
          ? {
              top: area.top,
              height: area.height,
              left: area.left + offset * area.width,
              width: share * area.width,
            }
          : {
              left: area.left,
              width: area.width,
              top: area.top + offset * area.height,
              height: share * area.height,
            },
        !horizontal,
      );
      offset += share;
    }
  };
  walk(
    layout.grid.root as GridNode,
    { top: 0, left: 0, width: 1, height: 1 },
    layout.grid.orientation === "HORIZONTAL",
  );
  return groups;
}

/**
 * The group box a hidden browser tab of a workspace that is not shown will
 * come forward in, read off that workspace's saved layout (decoded for its
 * tabs) the way its Dockview places the tab once the workspace is shown: the
 * tab's own group when the layout holds it; else, in a tidy layout, the
 * browser panel, or a new one along its side; else the group of its nearest
 * neighbour in the tab order, or the group last in use. Tab strip included.
 */
export function savedTabGroupArea(
  layout: SerializedDockview,
  spaceTabs: readonly Tab[],
  tab: BrowserTab,
  side: PanelSide | null,
): DockArea | null {
  const groups = savedGroupAreas(layout);
  if (groups.length === 0) return null;
  const groupOf = (tabId: number) => {
    const panelId = workspaceDockviewPanelId(tabId);
    return groups.find((group) => group.views.includes(panelId));
  };
  const own = groupOf(tab.id);
  if (own) return own.area;
  if (side) {
    // A browser tab never keeps a neighbour's spot in a tidy layout.
    const kinds = new Map(
      spaceTabs.map((each) => [workspaceDockviewPanelId(each.id), each.kind]),
    );
    const panelId = pickBrowserGroup(
      groups.map((group) => ({
        id: group.id,
        browserOnly: group.views.every((view) => kinds.get(view) === "browser"),
        left: group.area.left,
        right: group.area.left + group.area.width,
      })),
      side,
      null,
    );
    const panel = groups.find((group) => group.id === panelId);
    if (panel) return panel.area;
    return {
      top: 0,
      left: side === "right" ? 1 - BROWSER_PANEL_SHARE : 0,
      width: BROWSER_PANEL_SHARE,
      height: 1,
    };
  }
  const index = spaceTabs.findIndex((each) => each.id === tab.id);
  for (let at = index - 1; at >= 0; at -= 1) {
    const group = groupOf(spaceTabs[at].id);
    if (group) return group.area;
  }
  if (index >= 0) {
    for (let at = index + 1; at < spaceTabs.length; at += 1) {
      const group = groupOf(spaceTabs[at].id);
      if (group) return group.area;
    }
  }
  return (groups.find((group) => group.id === layout.activeGroup) ?? groups[0])
    .area;
}

/** For hidden browser tabs, the group box each will come forward in
 *  (savedTabGroupArea). Left out: the tabs of `followingSpaceId`, which follow
 *  the hidden host's box instead; Chrome and Edge tabs, which take the size of
 *  their own window; and a workspace whose saved layout places none of its
 *  tabs. */
export function savedBackgroundAreas(options: {
  hidden: readonly BrowserTab[];
  tabs: readonly Tab[];
  /** The workspace in view, once the hidden host was measured for its dock;
   *  null while the host still has the box of the workspace shown before. */
  followingSpaceId: string | null;
  sideOf: (spaceId: string) => PanelSide | null;
  layoutOf: (
    spaceId: string,
    spaceTabs: readonly Tab[],
  ) => SerializedDockview | null;
}): Map<number, DockArea> {
  const { hidden, tabs, followingSpaceId, sideOf, layoutOf } = options;
  const areas = new Map<number, DockArea>();
  const bySpace = new Map<string, BrowserTab[]>();
  for (const tab of hidden) {
    if (tab.spaceId === followingSpaceId || tab.external) continue;
    const list = bySpace.get(tab.spaceId) ?? [];
    list.push(tab);
    bySpace.set(tab.spaceId, list);
  }
  for (const [spaceId, spaceHidden] of bySpace) {
    const spaceTabs = tabs.filter((tab) => tab.spaceId === spaceId);
    const layout = layoutOf(spaceId, spaceTabs);
    if (!layout) continue;
    const side = sideOf(spaceId);
    for (const tab of spaceHidden) {
      const area = savedTabGroupArea(layout, spaceTabs, tab, side);
      if (area) areas.set(tab.id, area);
    }
  }
  return areas;
}
