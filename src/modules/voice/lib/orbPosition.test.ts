import { describe, expect, it } from "vitest";
import {
  clampOrbPosition,
  clampOrbX,
  ORB_BOTTOM_LIMIT,
  ORB_HEIGHT,
  ORB_TOP_LIMIT,
  ORB_WIDTH,
  orbX,
} from "./orbPosition";

describe("AnboVoice orb placement", () => {
  it("keeps a free position inside the workspace", () => {
    const viewport = { width: 1_000, height: 700 };
    expect(clampOrbPosition({ x: 420, y: 310 }, viewport)).toEqual({
      x: 420,
      y: 310,
    });
  });

  it("keeps the orb between header and status bar", () => {
    const viewport = { width: 800, height: 600 };
    expect(clampOrbPosition({ x: 200, y: -100 }, viewport).y).toBe(
      ORB_TOP_LIMIT,
    );
    expect(clampOrbPosition({ x: 200, y: 999 }, viewport).y).toBe(
      600 - ORB_BOTTOM_LIMIT - ORB_HEIGHT,
    );
  });

  it("keeps the docked orb inside narrow windows", () => {
    expect(orbX("left", 40)).toBe(12);
    expect(orbX("right", 40)).toBe(12);
  });

  it("keeps the orb inside the window while it is dragged", () => {
    expect(clampOrbX(-100, 800)).toBe(12);
    expect(clampOrbX(900, 800)).toBe(800 - 12 - ORB_WIDTH);
    expect(
      clampOrbPosition({ x: 900, y: 200 }, { width: 800, height: 600 }).x,
    ).toBe(800 - 12 - ORB_WIDTH);
  });
});
