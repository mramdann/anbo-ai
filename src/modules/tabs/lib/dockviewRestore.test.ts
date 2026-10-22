import type { DockviewApi, SerializedDockview } from "dockview-react";
import { describe, expect, it, vi } from "vitest";
import { restoreDockviewLayout } from "./dockviewRestore";

type FakeWatermark = { element: { remove: () => void }; dispose: () => void };
type FakeGroup = {
  id: string;
  panels: string[];
  dispose: () => void;
  model: { watermark?: FakeWatermark };
};

const watermark = (): FakeWatermark => ({
  element: { remove: vi.fn() },
  dispose: vi.fn(),
});

class FakeComponent {
  groups: FakeGroup[] = [];
  created: FakeGroup[] = [];
  createGroup(): FakeGroup {
    const group: FakeGroup = {
      id: `g${this.created.length}`,
      panels: [],
      dispose: vi.fn(),
      model: {},
    };
    this.created.push(group);
    return group;
  }
}

// What Dockview 4.13's fromJSON with reuseExistingPanels does with groups: a
// temporary group holds the kept panels, clear() disposes the old groups and
// then deactivates the active one, which gives it a new watermark, and the
// kept panels move to the new groups.
function fakeApi(component: FakeComponent) {
  return {
    component,
    get groups() {
      return component.groups;
    },
    fromJSON: vi.fn(() => {
      const temporary = component.createGroup();
      temporary.panels.push("panel-1");
      for (const old of component.groups) {
        old.dispose();
        old.model.watermark = watermark();
      }
      const fresh = component.createGroup();
      fresh.panels.push(temporary.panels.pop() as string);
      component.groups = [fresh];
    }),
  };
}

const layout = {} as SerializedDockview;

describe("restoreDockviewLayout", () => {
  it("disposes the group Dockview leaves out of the restored layout", () => {
    // Measured (round 63): 20 workspace switches left 21 more layout menus
    // mounted on detached elements and 14,000 more listeners.
    const component = new FakeComponent();
    const api = fakeApi(component);
    restoreDockviewLayout(api as unknown as DockviewApi, layout);
    expect(api.fromJSON).toHaveBeenCalledWith(layout, {
      reuseExistingPanels: true,
    });
    const [temporary, kept] = component.created;
    expect(temporary.dispose).toHaveBeenCalledTimes(1);
    expect(kept.dispose).not.toHaveBeenCalled();
    expect(
      Object.getOwnPropertyDescriptor(component, "createGroup"),
    ).toBeUndefined();
  });

  it("disposes the watermark a disposed group got when it was deactivated", () => {
    // Measured (round 63): 8 switches left 11 watermarks mounted, made by
    // clear() deactivating the group it had just disposed.
    const component = new FakeComponent();
    const old = component.createGroup();
    old.panels.push("panel-1");
    component.groups = [old];
    const api = fakeApi(component);
    restoreDockviewLayout(api as unknown as DockviewApi, layout);
    expect(old.model.watermark).toBeUndefined();
    const fresh = component.groups[0];
    expect(fresh).not.toBe(old);
    expect(fresh.model.watermark).toBeUndefined();
  });

  it("leaves the watermark of a group still in the layout", () => {
    const component = new FakeComponent();
    const api = fakeApi(component);
    api.fromJSON.mockImplementation(() => {
      const empty = component.createGroup();
      empty.model.watermark = watermark();
      component.groups = [empty];
    });
    restoreDockviewLayout(api as unknown as DockviewApi, layout);
    const [empty] = component.groups;
    expect(empty.model.watermark?.dispose).not.toHaveBeenCalled();
  });

  it("keeps a group that still holds panels", () => {
    const component = new FakeComponent();
    const api = fakeApi(component);
    api.fromJSON.mockImplementation(() => {
      const temporary = component.createGroup();
      temporary.panels.push("panel-1");
      throw new Error("corrupt layout");
    });
    expect(() =>
      restoreDockviewLayout(api as unknown as DockviewApi, layout),
    ).toThrow("corrupt layout");
    expect(component.created[0].dispose).not.toHaveBeenCalled();
  });

  it("still restores when the component cannot be reached", () => {
    const fromJSON = vi.fn();
    restoreDockviewLayout({ fromJSON } as unknown as DockviewApi, layout);
    expect(fromJSON).toHaveBeenCalledWith(layout, {
      reuseExistingPanels: true,
    });
  });
});
