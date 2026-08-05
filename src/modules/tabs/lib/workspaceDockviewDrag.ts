export type WorkspaceDockviewEdgeZone = "left" | "right" | "top" | "bottom";

export type RectLike = {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
};

export type WorkspaceDockviewHeaderTab = {
  tabId: number;
  rect: Pick<RectLike, "left" | "right" | "width">;
};

export type WorkspaceDockviewHeaderTarget = {
  tabId: number;
  placement: "before" | "after";
  gapIndex: number;
};

export type WorkspaceDockviewPreviewRect = Pick<
  RectLike,
  "left" | "top" | "width" | "height"
>;

const EDGE_BAND_RATIO = 0.25;
const MAX_EDGE_BAND_PX = 120;

export function resolveWorkspaceDockviewEdgeZone(
  rect: RectLike,
  clientX: number,
  clientY: number,
): WorkspaceDockviewEdgeZone | null {
  if (
    clientX < rect.left ||
    clientX > rect.right ||
    clientY < rect.top ||
    clientY > rect.bottom
  ) {
    return null;
  }

  const horizontalBand = Math.min(
    MAX_EDGE_BAND_PX,
    rect.width * EDGE_BAND_RATIO,
  );
  const verticalBand = Math.min(
    MAX_EDGE_BAND_PX,
    rect.height * EDGE_BAND_RATIO,
  );
  const candidates: Array<{
    zone: WorkspaceDockviewEdgeZone;
    distance: number;
  }> = [];
  const left = clientX - rect.left;
  const right = rect.right - clientX;
  const top = clientY - rect.top;
  const bottom = rect.bottom - clientY;

  if (left <= horizontalBand) candidates.push({ zone: "left", distance: left });
  if (right <= horizontalBand)
    candidates.push({ zone: "right", distance: right });
  if (top <= verticalBand) candidates.push({ zone: "top", distance: top });
  if (bottom <= verticalBand)
    candidates.push({ zone: "bottom", distance: bottom });

  candidates.sort((a, b) => a.distance - b.distance);
  return candidates[0]?.zone ?? null;
}

export function workspaceDockviewEdgePreviewRect(
  rect: RectLike,
  zone: WorkspaceDockviewEdgeZone,
): WorkspaceDockviewPreviewRect {
  const horizontal = zone === "left" || zone === "right";
  const width = horizontal ? rect.width / 2 : rect.width;
  const height = horizontal ? rect.height : rect.height / 2;
  return {
    left: zone === "right" ? rect.right - width : rect.left,
    top: zone === "bottom" ? rect.bottom - height : rect.top,
    width,
    height,
  };
}

export function calculateLinearReorderGap(
  tabIds: readonly number[],
  sourceId: number,
  targetId: number,
  placement: "before" | "after",
): number | null {
  if (sourceId === targetId || !tabIds.includes(sourceId)) return null;
  const targetIndex = tabIds.indexOf(targetId);
  if (targetIndex < 0) return null;
  return targetIndex + (placement === "after" ? 1 : 0);
}

export function resolveWorkspaceDockviewHeaderTarget(
  tabs: readonly WorkspaceDockviewHeaderTab[],
  clientX: number,
  directTabId: number | null,
): WorkspaceDockviewHeaderTarget | null {
  if (tabs.length === 0) return null;

  const directIndex =
    directTabId === null
      ? -1
      : tabs.findIndex((entry) => entry.tabId === directTabId);
  if (directIndex >= 0) {
    const direct = tabs[directIndex];
    const placement =
      clientX < direct.rect.left + direct.rect.width / 2 ? "before" : "after";
    return {
      tabId: direct.tabId,
      placement,
      gapIndex: directIndex + (placement === "after" ? 1 : 0),
    };
  }

  let nearest: WorkspaceDockviewHeaderTarget | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const [index, entry] of tabs.entries()) {
    const boundaries = [
      {
        distance: Math.abs(clientX - entry.rect.left),
        placement: "before" as const,
        gapIndex: index,
      },
      {
        distance: Math.abs(clientX - entry.rect.right),
        placement: "after" as const,
        gapIndex: index + 1,
      },
    ];
    for (const boundary of boundaries) {
      if (boundary.distance >= nearestDistance) continue;
      nearestDistance = boundary.distance;
      nearest = {
        tabId: entry.tabId,
        placement: boundary.placement,
        gapIndex: boundary.gapIndex,
      };
    }
  }
  return nearest;
}
