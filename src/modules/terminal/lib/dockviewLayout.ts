import type { SerializedDockview } from "dockview-react";
import type { PaneNode, SplitDir } from "./panes";

const LAYOUT_SIZE = 1_000;

type GridNode = SerializedDockview["grid"]["root"];
type GridOrientation = SerializedDockview["grid"]["orientation"];

const orientation = (dir: SplitDir): GridOrientation =>
  (dir === "row" ? "HORIZONTAL" : "VERTICAL") as GridOrientation;

export const terminalPanelId = (leafId: number) => `terminal:${leafId}`;

const terminalGroupId = (node: Extract<PaneNode, { kind: "leaf" }>) =>
  `terminal-group:${node.slotId ?? node.id}`;

type WeightedPane = { node: PaneNode; weight: number };

function splitChildren(
  node: Extract<PaneNode, { kind: "split" }>,
): WeightedPane[] {
  const weight = 1 / node.children.length;
  return node.children.flatMap((child) => {
    if (child.kind !== "split" || child.dir !== node.dir) {
      return [{ node: child, weight }];
    }
    return splitChildren(child).map((nested) => ({
      node: nested.node,
      weight: weight * nested.weight,
    }));
  });
}

function topologyKey(node: PaneNode): string {
  if (node.kind === "leaf") return `${node.slotId ?? node.id}=${node.id}`;
  return `${node.dir}(${splitChildren(node)
    .map(({ node: child, weight }) => `${weight}:${topologyKey(child)}`)
    .join(",")})`;
}

/** A cwd update does not change the Dockview topology. */
export function dockviewLayoutKey(node: PaneNode): string {
  return topologyKey(node);
}

export function paneTreeToDockviewLayout(
  paneTree: PaneNode,
  activeLeafId?: number,
): SerializedDockview {
  const panels: SerializedDockview["panels"] = {};
  const groupByLeaf = new Map<number, string>();

  const serialize = (node: PaneNode, size: number): GridNode => {
    if (node.kind === "leaf") {
      const panelId = terminalPanelId(node.id);
      const groupId = terminalGroupId(node);
      panels[panelId] = {
        id: panelId,
        contentComponent: "terminal",
        title: `Terminal ${node.id}`,
        params: { leafId: node.id },
      };
      groupByLeaf.set(node.id, groupId);
      return {
        type: "leaf",
        size,
        data: {
          id: groupId,
          views: [panelId],
          activeView: panelId,
          locked: "no-drop-target",
        },
      };
    }

    const children = splitChildren(node);
    return {
      type: "branch",
      size,
      data: children.map((child) =>
        serialize(child.node, LAYOUT_SIZE * child.weight),
      ),
    };
  };

  const rootDir = paneTree.kind === "split" ? paneTree.dir : "row";
  const serialized = serialize(paneTree, LAYOUT_SIZE);
  const root: GridNode =
    serialized.type === "branch"
      ? serialized
      : { type: "branch", size: LAYOUT_SIZE, data: [serialized] };
  const activeGroup =
    groupByLeaf.get(activeLeafId ?? -1) ?? groupByLeaf.values().next().value;

  return {
    grid: {
      root,
      width: LAYOUT_SIZE,
      height: LAYOUT_SIZE,
      orientation: orientation(rootDir),
    },
    panels,
    activeGroup,
  };
}
