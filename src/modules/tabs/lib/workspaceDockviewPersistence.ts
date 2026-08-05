import type { SerializedDockview } from "dockview-react";
import type { Tab } from "./useTabs";
import { workspaceDockviewPanelId } from "./workspaceDockviewLayout";

const WORKSPACE_DOCKVIEW_LAYOUT_VERSION = 1;

type LayoutStorage = Pick<Storage, "getItem" | "setItem">;

interface StoredWorkspaceDockviewLayout {
  runtimeTabIds: number[];
  layoutIdentities: string[];
  layout: SerializedDockview;
}

type TerminalPaneNode = Extract<Tab, { kind: "terminal" }>["paneTree"];

function terminalPaneIdentity(
  node: TerminalPaneNode,
  activeLeafId: number,
): unknown {
  if (node.kind === "leaf") {
    return ["leaf", node.cwd ?? null, node.id === activeLeafId];
  }
  return [
    "split",
    node.dir,
    node.children.map((child) => terminalPaneIdentity(child, activeLeafId)),
  ];
}

function tabLayoutIdentityBase(tab: Tab): string {
  switch (tab.kind) {
    case "terminal":
      return JSON.stringify([
        tab.kind,
        Boolean(tab.blocks),
        tab.customTitle ?? null,
        Boolean(tab.private),
        terminalPaneIdentity(tab.paneTree, tab.activeLeafId),
      ]);
    case "editor":
    case "markdown":
      return JSON.stringify([tab.kind, tab.path]);
    case "preview":
      return JSON.stringify([tab.kind, tab.url]);
    case "ai-diff":
      return JSON.stringify([
        tab.kind,
        tab.path,
        tab.approvalId,
        tab.status,
        tab.isNewFile,
      ]);
    case "git-diff":
      return JSON.stringify([
        tab.kind,
        tab.repoRoot,
        tab.path,
        tab.mode,
        tab.originalPath,
      ]);
    case "git-history":
      return JSON.stringify([tab.kind, tab.repoRoot]);
    case "git-commit-file":
      return JSON.stringify([
        tab.kind,
        tab.repoRoot,
        tab.sha,
        tab.path,
        tab.originalPath,
      ]);
  }
}

export function workspaceDockviewLayoutIdentities(
  tabs: readonly Tab[],
): string[] {
  const occurrences = new Map<string, number>();
  return tabs.map((tab) => {
    const base = tabLayoutIdentityBase(tab);
    const occurrence = occurrences.get(base) ?? 0;
    occurrences.set(base, occurrence + 1);
    return JSON.stringify([base, occurrence]);
  });
}

function remapGroupPanelIds(
  value: unknown,
  panelIds: Map<string, string>,
  dropUnmapped = false,
): void {
  if (!value || typeof value !== "object") return;
  const node = value as { type?: unknown; data?: unknown };
  if (node.type === "branch" && Array.isArray(node.data)) {
    for (const child of node.data) {
      remapGroupPanelIds(child, panelIds, dropUnmapped);
    }
    return;
  }
  const group = node.type === "leaf" ? node.data : value;
  if (!group || typeof group !== "object") return;
  const state = group as { views?: unknown; activeView?: unknown };
  if (Array.isArray(state.views)) {
    state.views = state.views.flatMap((id) => {
      if (typeof id !== "string") return dropUnmapped ? [] : [id];
      const remapped = panelIds.get(id);
      return remapped ? [remapped] : dropUnmapped ? [] : [id];
    });
  }
  if (typeof state.activeView === "string") {
    const remapped = panelIds.get(state.activeView);
    if (remapped) state.activeView = remapped;
    else if (dropUnmapped) delete state.activeView;
  }
}

function remapLayoutPanelIds(
  layout: SerializedDockview,
  panelIds: Map<string, string>,
  tabIdByPanel: Map<string, number>,
  dropUnmapped = false,
): SerializedDockview {
  const remapped = JSON.parse(JSON.stringify(layout)) as SerializedDockview;
  const panels: SerializedDockview["panels"] = {};
  for (const [oldId, panel] of Object.entries(remapped.panels)) {
    const mappedId = panelIds.get(oldId);
    if (!mappedId && dropUnmapped) continue;
    const id = mappedId ?? oldId;
    panels[id] = {
      ...panel,
      id,
      params: {
        ...panel.params,
        ...(tabIdByPanel.has(id) && { tabId: tabIdByPanel.get(id) }),
      },
    };
  }
  remapped.panels = panels;
  remapGroupPanelIds(remapped.grid.root, panelIds, dropUnmapped);
  for (const floating of remapped.floatingGroups ?? []) {
    remapGroupPanelIds(floating.data, panelIds, dropUnmapped);
  }
  for (const popout of remapped.popoutGroups ?? []) {
    remapGroupPanelIds(popout.data, panelIds, dropUnmapped);
  }
  return remapped;
}

function encodeLayoutSlots(
  layout: SerializedDockview,
  tabIds: readonly number[],
): SerializedDockview {
  const panelIds = new Map<string, string>();
  const tabIdBySlot = new Map<string, number>();
  tabIds.forEach((tabId, index) => {
    const slot = `slot:${index}`;
    panelIds.set(workspaceDockviewPanelId(tabId), slot);
    tabIdBySlot.set(slot, index);
  });
  return remapLayoutPanelIds(layout, panelIds, tabIdBySlot);
}

function remapLayoutSlots(
  layout: SerializedDockview,
  tabIdBySlot: ReadonlyMap<number, number>,
  dropUnmapped = false,
): SerializedDockview {
  const panelIds = new Map<string, string>();
  const tabIdByPanel = new Map<string, number>();
  for (const [index, tabId] of tabIdBySlot) {
    const panelId = workspaceDockviewPanelId(tabId);
    panelIds.set(`slot:${index}`, panelId);
    tabIdByPanel.set(panelId, tabId);
  }
  return remapLayoutPanelIds(layout, panelIds, tabIdByPanel, dropUnmapped);
}

function hasValidLayoutReferences(
  layout: SerializedDockview,
  panelIds: Set<string>,
): boolean {
  const referenced = new Set<string>();
  const visitGroup = (value: unknown): boolean => {
    if (!value || typeof value !== "object") return false;
    const group = value as {
      id?: unknown;
      views?: unknown;
      activeView?: unknown;
    };
    if (typeof group.id !== "string" || !Array.isArray(group.views)) {
      return false;
    }
    for (const panelId of group.views) {
      if (
        typeof panelId !== "string" ||
        !panelIds.has(panelId) ||
        referenced.has(panelId)
      ) {
        return false;
      }
      referenced.add(panelId);
    }
    return (
      group.activeView === undefined ||
      (typeof group.activeView === "string" &&
        group.views.includes(group.activeView))
    );
  };
  const visitGrid = (node: unknown): boolean => {
    if (!node || typeof node !== "object") return false;
    const value = node as {
      type?: unknown;
      data?: unknown;
      size?: unknown;
      visible?: unknown;
    };
    if (
      value.size !== undefined &&
      (typeof value.size !== "number" || !Number.isFinite(value.size))
    ) {
      return false;
    }
    if (value.visible !== undefined && typeof value.visible !== "boolean")
      return false;
    if (value.type === "branch") {
      return Array.isArray(value.data) && value.data.every(visitGrid);
    }
    return value.type === "leaf" && visitGroup(value.data);
  };

  if (!visitGrid(layout.grid.root)) return false;
  if (
    layout.floatingGroups !== undefined &&
    (!Array.isArray(layout.floatingGroups) ||
      !layout.floatingGroups.every(
        (floating) =>
          floating && typeof floating === "object" && visitGroup(floating.data),
      ))
  ) {
    return false;
  }
  if (
    layout.popoutGroups !== undefined &&
    (!Array.isArray(layout.popoutGroups) ||
      !layout.popoutGroups.every(
        (popout) =>
          popout && typeof popout === "object" && visitGroup(popout.data),
      ))
  ) {
    return false;
  }
  return (
    referenced.size === panelIds.size &&
    [...panelIds].every((panelId) => referenced.has(panelId))
  );
}

function isUniqueTabIdList(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.every((tabId) => Number.isFinite(tabId)) &&
    new Set(value).size === value.length
  );
}

function isUniqueLayoutIdentityList(
  value: unknown,
  expectedLength: number,
): value is string[] {
  if (!Array.isArray(value) || value.length !== expectedLength) return false;
  const occurrences = new Map<string, number>();
  for (const identity of value) {
    if (typeof identity !== "string" || identity.length === 0) return false;
    try {
      const parsed: unknown = JSON.parse(identity);
      if (
        !Array.isArray(parsed) ||
        parsed.length !== 2 ||
        typeof parsed[0] !== "string" ||
        !Array.isArray(JSON.parse(parsed[0])) ||
        typeof parsed[1] !== "number" ||
        !Number.isSafeInteger(parsed[1]) ||
        parsed[1] !== (occurrences.get(parsed[0]) ?? 0)
      ) {
        return false;
      }
      occurrences.set(parsed[0], parsed[1] + 1);
    } catch {
      return false;
    }
  }
  return new Set(value).size === value.length;
}

function slotTabIds(count: number): Map<string, number> {
  return new Map(
    Array.from({ length: count }, (_, index) => [`slot:${index}`, index]),
  );
}

function runtimePanelTabIds(tabIds: readonly number[]): Map<string, number> {
  return new Map(
    tabIds.map((tabId) => [workspaceDockviewPanelId(tabId), tabId]),
  );
}

function isWorkspaceDockviewLayoutForPanelTabs(
  value: unknown,
  expectedPanels: ReadonlyMap<string, number>,
): value is SerializedDockview {
  if (!value || typeof value !== "object") return false;
  const layout = value as Partial<SerializedDockview>;
  if (
    !layout.grid ||
    typeof layout.grid !== "object" ||
    !layout.panels ||
    typeof layout.panels !== "object" ||
    Array.isArray(layout.panels)
  ) {
    return false;
  }
  if (
    layout.grid.root?.type !== "branch" ||
    !Array.isArray(layout.grid.root.data) ||
    !Number.isFinite(layout.grid.width) ||
    !Number.isFinite(layout.grid.height) ||
    (layout.grid.orientation !== "HORIZONTAL" &&
      layout.grid.orientation !== "VERTICAL")
  ) {
    return false;
  }

  const savedIds = Object.keys(layout.panels).sort();
  const expectedIds = [...expectedPanels.keys()].sort();
  if (
    savedIds.length !== expectedIds.length ||
    !savedIds.every((id, index) => id === expectedIds[index]) ||
    savedIds.some((id) => {
      const panel = layout.panels?.[id];
      return (
        !panel ||
        panel.id !== id ||
        panel.contentComponent !== "workspace" ||
        panel.params?.tabId !== expectedPanels.get(id)
      );
    })
  ) {
    return false;
  }
  return hasValidLayoutReferences(
    layout as SerializedDockview,
    new Set(savedIds),
  );
}

export function workspaceDockviewLayoutKey(spaceId: string): string {
  return `anbo:workspace-dockview-layout:v${WORKSPACE_DOCKVIEW_LAYOUT_VERSION}:${encodeURIComponent(spaceId)}`;
}

export function isWorkspaceDockviewLayoutForTabs(
  value: unknown,
  tabIds: readonly number[],
): value is SerializedDockview {
  return (
    isUniqueTabIdList(tabIds) &&
    isWorkspaceDockviewLayoutForPanelTabs(value, runtimePanelTabIds(tabIds))
  );
}

export function readWorkspaceDockviewLayout(
  storage: LayoutStorage,
  spaceId: string,
  tabs: readonly Tab[],
): SerializedDockview | null {
  try {
    const serialized = storage.getItem(workspaceDockviewLayoutKey(spaceId));
    if (!serialized) return null;
    const parsed: unknown = JSON.parse(serialized);
    const tabIds = tabs.map((tab) => tab.id);
    if (!parsed || typeof parsed !== "object" || !isUniqueTabIdList(tabIds)) {
      return null;
    }

    if ("runtimeTabIds" in parsed || "layout" in parsed) {
      const stored = parsed as Partial<StoredWorkspaceDockviewLayout>;
      if (
        !isUniqueTabIdList(stored.runtimeTabIds) ||
        ("layoutIdentities" in stored &&
          !isUniqueLayoutIdentityList(
            stored.layoutIdentities,
            stored.runtimeTabIds.length,
          )) ||
        !isWorkspaceDockviewLayoutForPanelTabs(
          stored.layout,
          slotTabIds(stored.runtimeTabIds.length),
        )
      ) {
        return null;
      }

      const currentIds = new Set(tabIds);
      const matchingSlots = new Map<number, number>();
      const matchedCurrentIds = new Set<number>();
      stored.runtimeTabIds.forEach((tabId, index) => {
        if (!currentIds.has(tabId)) return;
        matchingSlots.set(index, tabId);
        matchedCurrentIds.add(tabId);
      });

      if (stored.layoutIdentities) {
        const currentIdsByIdentity = new Map(
          workspaceDockviewLayoutIdentities(tabs).map((identity, index) => [
            identity,
            tabIds[index],
          ]),
        );
        stored.layoutIdentities.forEach((identity, index) => {
          if (matchingSlots.has(index)) return;
          const tabId = currentIdsByIdentity.get(identity);
          if (tabId === undefined || matchedCurrentIds.has(tabId)) return;
          matchingSlots.set(index, tabId);
          matchedCurrentIds.add(tabId);
        });
      } else if (matchingSlots.size === 0) {
        if (stored.runtimeTabIds.length !== tabIds.length) return null;
        tabIds.forEach((tabId, index) => {
          matchingSlots.set(index, tabId);
        });
      }

      const decoded = remapLayoutSlots(stored.layout, matchingSlots, true);
      return isWorkspaceDockviewLayoutForPanelTabs(
        decoded,
        runtimePanelTabIds([...matchingSlots.values()]),
      )
        ? decoded
        : null;
    }

    if (
      !isWorkspaceDockviewLayoutForPanelTabs(parsed, slotTabIds(tabIds.length))
    ) {
      return null;
    }
    const slots = new Map(tabIds.map((tabId, index) => [index, tabId]));
    const decoded = remapLayoutSlots(parsed, slots);
    return isWorkspaceDockviewLayoutForTabs(decoded, tabIds) ? decoded : null;
  } catch {
    return null;
  }
}

export function writeWorkspaceDockviewLayout(
  storage: LayoutStorage,
  spaceId: string,
  layout: SerializedDockview,
  tabs: readonly Tab[],
): void {
  try {
    const tabIds = tabs.map((tab) => tab.id);
    storage.setItem(
      workspaceDockviewLayoutKey(spaceId),
      JSON.stringify({
        runtimeTabIds: [...tabIds],
        layoutIdentities: workspaceDockviewLayoutIdentities(tabs),
        layout: encodeLayoutSlots(layout, tabIds),
      } satisfies StoredWorkspaceDockviewLayout),
    );
  } catch {
    // Persistence is best-effort when storage is unavailable or full.
  }
}
