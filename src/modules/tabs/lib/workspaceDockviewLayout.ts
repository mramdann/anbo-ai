import type {
  AddPanelPositionOptions,
  DockviewGroupPanel,
  IDockviewPanel,
  SerializedDockview,
} from "dockview-react";

const LAYOUT_SIZE = 1_000;

export const WORKSPACE_DOCKVIEW_GROUP_ID = "workspace-tabs";
export const WORKSPACE_DOCKVIEW_COMPONENT = "workspace";

export function workspaceDockviewPanelId(tabId: number): string {
  return `tab:${tabId}`;
}

export function workspaceDockviewInsertionPosition(
  activeGroup: DockviewGroupPanel | undefined,
  fallbackPanel: IDockviewPanel | null,
  fallbackIndex: number,
): AddPanelPositionOptions | undefined {
  if (activeGroup) {
    return {
      referenceGroup: activeGroup,
      index: activeGroup.panels.length,
    };
  }
  if (fallbackPanel) {
    return { referencePanel: fallbackPanel, index: fallbackIndex };
  }
  return undefined;
}

export function workspaceTabsToDockviewLayout(
  tabIds: readonly number[],
  activeId: number,
  hideHeader = false,
): SerializedDockview {
  const views = tabIds.map(workspaceDockviewPanelId);
  const requestedActiveView = workspaceDockviewPanelId(activeId);
  const activeView = views.includes(requestedActiveView)
    ? requestedActiveView
    : views[0];
  const panels: SerializedDockview["panels"] = {};

  for (const tabId of tabIds) {
    const id = workspaceDockviewPanelId(tabId);
    panels[id] = {
      id,
      contentComponent: WORKSPACE_DOCKVIEW_COMPONENT,
      title: `Tab ${tabId}`,
      params: { tabId },
    };
  }

  return {
    grid: {
      root: {
        type: "branch",
        size: LAYOUT_SIZE,
        data: [
          {
            type: "leaf",
            size: LAYOUT_SIZE,
            data: {
              id: WORKSPACE_DOCKVIEW_GROUP_ID,
              views,
              activeView,
              hideHeader,
            },
          },
        ],
      },
      width: LAYOUT_SIZE,
      height: LAYOUT_SIZE,
      orientation: "HORIZONTAL" as SerializedDockview["grid"]["orientation"],
    },
    panels,
    activeGroup: WORKSPACE_DOCKVIEW_GROUP_ID,
  };
}
