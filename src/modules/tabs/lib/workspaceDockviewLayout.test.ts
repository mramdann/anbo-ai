import type { DockviewGroupPanel, IDockviewPanel } from "dockview-react";
import { describe, expect, it } from "vitest";
import {
  WORKSPACE_DOCKVIEW_GROUP_ID,
  workspaceDockviewInsertionPosition,
  workspaceDockviewPanelId,
  workspaceTabsToDockviewLayout,
} from "./workspaceDockviewLayout";

type SerializedWorkspaceGroup = {
  id: string;
  views: string[];
  activeView?: string;
  hideHeader?: boolean;
};

function serializedGroup(
  layout: ReturnType<typeof workspaceTabsToDockviewLayout>,
) {
  const root = layout.grid.root;
  if (!Array.isArray(root.data) || root.data[0]?.type !== "leaf") {
    throw new Error("expected a single serialized workspace group");
  }
  return root.data[0].data as SerializedWorkspaceGroup;
}

describe("workspaceTabsToDockviewLayout", () => {
  it("uses stable top-level panel ids", () => {
    expect(workspaceDockviewPanelId(7)).toBe("tab:7");
    expect(
      Object.keys(workspaceTabsToDockviewLayout([7, 12], 7).panels),
    ).toEqual(["tab:7", "tab:12"]);
  });

  it("keeps views in authoritative tab order", () => {
    const layout = workspaceTabsToDockviewLayout([12, 4, 9], 4);

    expect(serializedGroup(layout)).toMatchObject({
      id: WORKSPACE_DOCKVIEW_GROUP_ID,
      views: ["tab:12", "tab:4", "tab:9"],
      activeView: "tab:4",
    });
  });

  it("falls back to the first view when activeId is absent", () => {
    const layout = workspaceTabsToDockviewLayout([3, 8], 99);

    expect(serializedGroup(layout).activeView).toBe("tab:3");
  });

  it("hides the center tab chrome in zen mode", () => {
    const layout = workspaceTabsToDockviewLayout([3], 3, true);

    expect(serializedGroup(layout).hideHeader).toBe(true);
  });

  it("serializes an empty workspace group", () => {
    const layout = workspaceTabsToDockviewLayout([], -1);

    expect(serializedGroup(layout)).toMatchObject({
      id: WORKSPACE_DOCKVIEW_GROUP_ID,
      views: [],
    });
    expect(serializedGroup(layout).activeView).toBeUndefined();
    expect(layout.panels).toEqual({});
  });

  it("serializes tabId parameters for the custom panel and tab", () => {
    const layout = workspaceTabsToDockviewLayout([42], 42);

    expect(layout.panels["tab:42"]).toMatchObject({
      id: "tab:42",
      contentComponent: "workspace",
      params: { tabId: 42 },
    });
  });
});

describe("workspaceDockviewInsertionPosition", () => {
  it("targets the active split group instead of a neighbor in another group", () => {
    const activeGroup = {
      panels: [{ id: "tab:1" }, { id: "tab:3" }],
    } as DockviewGroupPanel;
    const neighbor = { id: "tab:2" } as IDockviewPanel;

    expect(
      workspaceDockviewInsertionPosition(activeGroup, neighbor, 1),
    ).toEqual({
      referenceGroup: activeGroup,
      index: 2,
    });
  });

  it("uses the ordered neighbor only while no group is active", () => {
    const neighbor = { id: "tab:2" } as IDockviewPanel;

    expect(workspaceDockviewInsertionPosition(undefined, neighbor, 1)).toEqual({
      referencePanel: neighbor,
      index: 1,
    });
    expect(
      workspaceDockviewInsertionPosition(undefined, null, 0),
    ).toBeUndefined();
  });
});
