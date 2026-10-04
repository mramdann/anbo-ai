import { describe, expect, it } from "vitest";
import {
  browserPanelSide,
  isOnSide,
  keepsNeighborSpot,
  oppositeSide,
  pickBrowserGroup,
  type TidyGroup,
  tidyPlacement,
} from "./workspaceTidyLayout";

const group = (
  id: string,
  left: number,
  right: number,
  browserOnly = false,
): TidyGroup => ({ id, left, right, browserOnly });

describe("browserPanelSide", () => {
  it("maps each mode to the browser panel's edge", () => {
    expect(browserPanelSide("browser-right")).toBe("right");
    expect(browserPanelSide("browser-left")).toBe("left");
    expect(browserPanelSide("free")).toBeNull();
    expect(browserPanelSide(undefined)).toBeNull();
    expect(oppositeSide("right")).toBe("left");
  });
});

describe("isOnSide", () => {
  it("places a half-width group on its side and a full-width one on neither", () => {
    expect(isOnSide(group("a", 960, 1920), "right", 960)).toBe(true);
    expect(isOnSide(group("a", 960, 1920), "left", 960)).toBe(false);
    expect(isOnSide(group("a", 0, 1920), "right", 960)).toBe(false);
    expect(isOnSide(group("a", 0, 1920), "left", 960)).toBe(false);
  });
});

describe("pickBrowserGroup", () => {
  const work = group("work", 0, 760);
  const near = group("near", 760, 1300, true);
  const far = group("far", 1300, 1920, true);

  it("keeps the remembered panel while it holds only browsers", () => {
    expect(pickBrowserGroup([work, near, far], "right", "near")).toBe("near");
  });

  it("otherwise takes the browser-only group furthest toward the side", () => {
    expect(pickBrowserGroup([work, near, far], "right", null)).toBe("far");
    expect(pickBrowserGroup([work, near, far], "left", null)).toBe("near");
    expect(pickBrowserGroup([work, near, far], "right", "work")).toBe("far");
  });

  it("is null when no group holds only browsers", () => {
    expect(pickBrowserGroup([work], "right", null)).toBeNull();
  });
});

describe("tidyPlacement", () => {
  const base = {
    side: "right" as const,
    browserGroupId: "browser",
    activeGroupId: "work",
    groupIds: ["work", "browser"],
  };

  it("sends a browser tab to the browser panel, or opens one on its side", () => {
    expect(tidyPlacement({ ...base, browser: true })).toEqual({
      group: "browser",
    });
    expect(
      tidyPlacement({ ...base, browser: true, browserGroupId: null }),
    ).toEqual({ newGroup: "right" });
  });

  it("keeps other tabs in the group in use", () => {
    expect(tidyPlacement({ ...base, browser: false })).toEqual({
      group: "work",
    });
  });

  it("moves other tabs off the browser panel while it is the one in use", () => {
    expect(
      tidyPlacement({
        ...base,
        browser: false,
        activeGroupId: "browser",
        groupIds: ["browser", "notes", "work"],
      }),
    ).toEqual({ group: "notes" });
    expect(
      tidyPlacement({
        ...base,
        browser: false,
        activeGroupId: "browser",
        groupIds: ["browser"],
      }),
    ).toEqual({ newGroup: "left" });
  });
});

describe("keepsNeighborSpot", () => {
  const spot = (browser: boolean, neighborGroupId: string | null) =>
    keepsNeighborSpot({ browser, neighborGroupId, browserGroupId: "browser" });

  it("keeps another tab beside a neighbour outside the browser panel", () => {
    expect(spot(false, "work")).toBe(true);
  });

  it("sends browser tabs, and tabs beside a browser, through the tidy rule", () => {
    expect(spot(true, "work")).toBe(false);
    expect(spot(false, "browser")).toBe(false);
    expect(spot(false, null)).toBe(false);
  });
});
