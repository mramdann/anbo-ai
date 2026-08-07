import { describe, expect, it } from "vitest";
import { rectsIntersect } from "./nativeVisibility";

function rect(left: number, top: number, width: number, height: number) {
  return {
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
  };
}

describe("native preview overlay overlap", () => {
  it("ignores dropdowns outside the preview", () => {
    expect(rectsIntersect(rect(0, 0, 100, 30), rect(0, 40, 500, 400))).toBe(
      false,
    );
  });

  it("detects overlays that cover part of the preview", () => {
    expect(rectsIntersect(rect(20, 20, 200, 100), rect(0, 40, 500, 400))).toBe(
      true,
    );
  });
});
