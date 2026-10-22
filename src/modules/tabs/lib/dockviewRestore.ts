import type { DockviewApi, SerializedDockview } from "dockview-react";

type Watermark = { element?: HTMLElement; dispose?: () => void };
type GroupLike = {
  readonly panels: readonly unknown[];
  dispose(): void;
  readonly model?: { watermark?: Watermark };
};
type GroupFactory = { createGroup?: (...args: unknown[]) => GroupLike };

/**
 * `api.fromJSON` keeping the panels that exist, without what it leaks. Every
 * workspace switch runs it, and Dockview 4.13 left two things mounted on
 * detached elements each time, which held a day's 444k listeners and slowed
 * switches from 0.7 s to 2.5 s (round 60):
 * - the temporary group that holds the kept panels, never added to the
 *   layout or disposed, with its header actions (the layout menu and its
 *   document key listener);
 * - a watermark that the active group gets after clear() has disposed it,
 *   when Dockview then deactivates it.
 */
export function restoreDockviewLayout(
  api: DockviewApi,
  layout: SerializedDockview,
): void {
  const component = (api as unknown as { component?: GroupFactory }).component;
  const create = component?.createGroup;
  if (!component || typeof create !== "function") {
    api.fromJSON(layout, { reuseExistingPanels: true });
    return;
  }
  const before = [...api.groups] as unknown as GroupLike[];
  const own =
    Object.getOwnPropertyDescriptor(component, "createGroup") !== undefined;
  const created: GroupLike[] = [];
  component.createGroup = (...args: unknown[]) => {
    const group = create.apply(component, args);
    created.push(group);
    return group;
  };
  try {
    api.fromJSON(layout, { reuseExistingPanels: true });
  } finally {
    if (own) component.createGroup = create;
    else delete component.createGroup;
    const inLayout = new Set<unknown>(api.groups);
    for (const group of created) {
      if (!inLayout.has(group) && group.panels.length === 0) group.dispose();
    }
    for (const group of [...before, ...created]) {
      const model = group.model;
      const watermark = model?.watermark;
      if (inLayout.has(group) || !model || !watermark) continue;
      watermark.element?.remove();
      watermark.dispose?.();
      model.watermark = undefined;
    }
  }
}
