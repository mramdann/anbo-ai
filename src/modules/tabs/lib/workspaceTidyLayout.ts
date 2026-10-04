/**
 * Tidy workspace layouts: browser tabs keep to one panel on a chosen side and
 * every other tab to the rest of the dock, so an agent's terminal stays put
 * while the pages it opens and closes come and go beside it.
 */

/** How a workspace arranges its dock. "free" keeps Dockview's own placement. */
export type WorkspaceLayoutMode = "free" | "browser-right" | "browser-left";

export type PanelSide = "left" | "right";

export const WORKSPACE_LAYOUT_MODES: readonly WorkspaceLayoutMode[] = [
  "free",
  "browser-right",
  "browser-left",
];

export const WORKSPACE_LAYOUT_LABELS: Record<WorkspaceLayoutMode, string> = {
  free: "Free layout",
  "browser-right": "Agents left, browser right",
  "browser-left": "Browser left, agents right",
};

/**
 * The browser panel's share of the dock when the layout opens it: about
 * 1,150 px of a 1,920 px wide dock, where most sites use their desktop layout.
 */
export const BROWSER_PANEL_SHARE = 0.6;

/** The edge that holds the browser panel, or null for a free layout. */
export function browserPanelSide(
  mode: WorkspaceLayoutMode | undefined,
): PanelSide | null {
  if (mode === "browser-right") return "right";
  if (mode === "browser-left") return "left";
  return null;
}

export function oppositeSide(side: PanelSide): PanelSide {
  return side === "right" ? "left" : "right";
}

/** What the layout needs to know about one Dockview group. */
export type TidyGroup = {
  id: string;
  /** Every panel in it is a browser tab; an empty group counts as well. */
  browserOnly: boolean;
  /** Horizontal extent, in any unit the groups share. */
  left: number;
  right: number;
};

/** Whether a group sits on `side` of a dock whose middle is at `middle`. A
 *  group spanning the whole dock sits on neither. */
export function isOnSide(
  group: TidyGroup,
  side: PanelSide,
  middle: number,
): boolean {
  const center = (group.left + group.right) / 2;
  return side === "right" ? center > middle : center < middle;
}

/**
 * The group that holds browser tabs: the remembered one while it still holds
 * only browsers, else the browser-only group furthest toward `side`.
 */
export function pickBrowserGroup(
  groups: readonly TidyGroup[],
  side: PanelSide,
  rememberedId: string | null,
): string | null {
  const candidates = groups.filter((group) => group.browserOnly);
  if (candidates.some((group) => group.id === rememberedId)) {
    return rememberedId;
  }
  let best: TidyGroup | null = null;
  for (const group of candidates) {
    if (
      !best ||
      (side === "right" ? group.right > best.right : group.left < best.left)
    ) {
      best = group;
    }
  }
  return best?.id ?? null;
}

/** Where a new tab goes: an existing group, or a new group on one edge. */
export type TidyPlacement = { group: string } | { newGroup: PanelSide };

/**
 * A browser tab goes to the browser panel, opened on `side` when there is
 * none. Any other tab goes to the group in use, or to the most recent other
 * group while the browser panel is the one in use, or to a new group on the
 * opposite edge when the browser panel is all there is.
 */
export function tidyPlacement(options: {
  browser: boolean;
  side: PanelSide;
  browserGroupId: string | null;
  activeGroupId: string | null;
  /** Existing groups, the most recently used first. */
  groupIds: readonly string[];
}): TidyPlacement {
  const { browser, side, browserGroupId, activeGroupId, groupIds } = options;
  if (browser) {
    return browserGroupId ? { group: browserGroupId } : { newGroup: side };
  }
  if (activeGroupId && activeGroupId !== browserGroupId) {
    return { group: activeGroupId };
  }
  const other = groupIds.find((id) => id !== browserGroupId);
  return other ? { group: other } : { newGroup: oppositeSide(side) };
}

/**
 * Whether a tab the saved layout could not place, such as one an agent opened
 * while the workspace was not shown, keeps its spot beside its neighbour. A
 * browser tab never does, and no tab does when that spot is in the browser
 * panel; those follow tidyPlacement instead.
 */
export function keepsNeighborSpot(options: {
  browser: boolean;
  neighborGroupId: string | null;
  browserGroupId: string | null;
}): boolean {
  const { browser, neighborGroupId, browserGroupId } = options;
  return (
    !browser && neighborGroupId !== null && neighborGroupId !== browserGroupId
  );
}
