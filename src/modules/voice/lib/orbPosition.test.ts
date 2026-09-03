import { describe, expect, it } from "vitest";
import {
  clampOrbX,
  clampOrbPosition,
  nearestOrbSide,
  ORB_BOTTOM_LIMIT,
  ORB_SIZE,
  ORB_TOP_LIMIT,
  orbX,
} from "./orbPosition";

describe("AnboVoice orb placement", () => {
  it("snaps to the nearest horizontal edge", () => {
    expect(nearestOrbSide(100, 1_000)).toBe("left");
    expect(nearestOrbSide(800, 1_000)).toBe("right");
  });

  it("keeps the orb between header and status bar", () => {
    const viewport = { width: 800, height: 600 };
    expect(clampOrbPosition({ side: "left", y: -100 }, viewport).y).toBe(
      ORB_TOP_LIMIT,
    );
    expect(clampOrbPosition({ side: "right", y: 999 }, viewport).y).toBe(
      600 - ORB_BOTTOM_LIMIT - ORB_SIZE,
    );
  });

  it("keeps the docked orb inside narrow windows", () => {
    expect(orbX("left", 40)).toBe(12);
    expect(orbX("right", 40)).toBe(12);
  });

  it("keeps the orb inside the window while it is dragged", () => {
    expect(clampOrbX(-100, 800)).toBe(12);
    expect(clampOrbX(900, 800)).toBe(800 - 12 - ORB_SIZE);
  });
});
