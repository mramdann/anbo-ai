import { describe, expect, it } from "vitest";
import {
  BROWSER_PANEL_ATTRIBUTE,
  dockAreaStyle,
  dockContentArea,
} from "./dockContentArea";

type Box = { top: number; left: number; width: number; height: number };
type FakeGroup = { content: Box; active?: boolean; browserPanel?: boolean };

// The dock's DOM as dockview builds it, reduced to what the measurement reads.
function dock(outer: Box, groups: FakeGroup[]): HTMLElement {
  const elements = groups.map((group) => {
    const content = { getBoundingClientRect: () => group.content };
    return {
      active: !!group.active,
      browserPanel: !!group.browserPanel,
      element: {
        querySelector: (selector: string) =>
          selector === ":scope > .dv-content-container" ? content : null,
      },
    };
  });
  // The group selectors dockContentArea uses: active or not, browser panel
  // or not panel.
  const matches =
    (selector: string) =>
    (group: (typeof elements)[number]): boolean => {
      if (selector.includes(".dv-active-group") && !group.active) return false;
      if (selector.includes(`:not([${BROWSER_PANEL_ATTRIBUTE}])`)) {
        return !group.browserPanel;
      }
      if (selector.includes(`[${BROWSER_PANEL_ATTRIBUTE}]`)) {
        return group.browserPanel;
      }
      return true;
    };
  return {
    getBoundingClientRect: () => outer,
    querySelector: (selector: string) =>
      elements.find(matches(selector))?.element ?? null,
  } as unknown as HTMLElement;
}

const dockBox = { top: 40, left: 330, width: 1600, height: 800 };

describe("dockContentArea", () => {
  it("is the active group's content box as a share of the dock", () => {
    // The content starts below the tab strip and an inset the group adds.
    expect(
      dockContentArea(
        dock(dockBox, [
          {
            content: { top: 72, left: 330, width: 1600, height: 768 },
            active: true,
          },
        ]),
      ),
    ).toEqual({ top: 0.04, left: 0, width: 1, height: 0.96 });
  });

  it("follows the active group in a split, else the first group", () => {
    const split = [
      { content: { top: 72, left: 330, width: 800, height: 768 } },
      {
        content: { top: 72, left: 1130, width: 800, height: 768 },
        active: true,
      },
    ];
    expect(dockContentArea(dock(dockBox, split))?.left).toBe(0.5);
    expect(
      dockContentArea(
        dock(
          dockBox,
          split.map(({ content }) => ({ content })),
        ),
      )?.left,
    ).toBe(0);
  });

  it("is null before the first group or while nothing has an area", () => {
    expect(dockContentArea(dock(dockBox, []))).toBeNull();
    expect(
      dockContentArea(
        dock(dockBox, [
          {
            content: { top: 72, left: 330, width: 0, height: 0 },
            active: true,
          },
        ]),
      ),
    ).toBeNull();
  });
});

describe("dockAreaStyle", () => {
  it("places a host by shares of the dock, so the UI zoom cannot shrink it", () => {
    expect(
      dockAreaStyle({ top: 0.04, left: 0, width: 1, height: 0.96 }),
    ).toEqual({
      top: "4%",
      left: "0%",
      width: "100%",
      height: "96%",
    });
    expect(dockAreaStyle(null)).toEqual({ inset: 0 });
  });

  describe("in a tidy layout", () => {
    const work = { top: 72, left: 330, width: 640, height: 768 };
    const panel = { top: 72, left: 970, width: 960, height: 768 };

    it("gives hidden browser tabs the browser panel's box", () => {
      const groups = [
        { content: work, active: true },
        { content: panel, browserPanel: true },
      ];
      expect(dockContentArea(dock(dockBox, groups), "browser")).toEqual({
        top: 0.04,
        left: 0.4,
        width: 0.6,
        height: 0.96,
      });
      expect(dockContentArea(dock(dockBox, groups), "other")?.left).toBe(0);
    });

    it("keeps other hidden tabs out of the browser panel while it is in use", () => {
      const groups = [
        { content: work },
        { content: panel, active: true, browserPanel: true },
      ];
      expect(dockContentArea(dock(dockBox, groups), "other")?.width).toBe(0.4);
      expect(dockContentArea(dock(dockBox, groups), "browser")?.width).toBe(
        0.6,
      );
    });
  });

  it("gives both kinds the active group's box without a browser panel", () => {
    const groups = [
      { content: { top: 72, left: 330, width: 800, height: 768 } },
      {
        content: { top: 72, left: 1130, width: 800, height: 768 },
        active: true,
      },
    ];
    expect(dockContentArea(dock(dockBox, groups), "browser")?.left).toBe(0.5);
    expect(dockContentArea(dock(dockBox, groups), "other")?.left).toBe(0.5);
  });
});
