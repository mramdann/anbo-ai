import { describe, expect, it } from "vitest";
import { dockAreaStyle, dockContentArea } from "./dockContentArea";

type Box = { top: number; left: number; width: number; height: number };
type FakeGroup = { content: Box; active?: boolean };

// The dock's DOM as dockview builds it, reduced to what the measurement reads.
function dock(outer: Box, groups: FakeGroup[]): HTMLElement {
  const elements = groups.map((group) => {
    const content = { getBoundingClientRect: () => group.content };
    return {
      active: !!group.active,
      element: {
        querySelector: (selector: string) =>
          selector === ":scope > .dv-content-container" ? content : null,
      },
    };
  });
  return {
    getBoundingClientRect: () => outer,
    querySelector: (selector: string) => {
      if (selector === ".dv-groupview.dv-active-group") {
        return elements.find((group) => group.active)?.element ?? null;
      }
      if (selector === ".dv-groupview") return elements[0]?.element ?? null;
      return null;
    },
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
});
