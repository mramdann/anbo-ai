import { describe, expect, it } from "vitest";
import { countClippedTabs, formatClippedTabCount } from "./tabOverflow";

describe("workspace tab overflow", () => {
  it("counts only tabs clipped outside the visible header", () => {
    const container = { left: 100, right: 400 };
    expect(
      countClippedTabs(container, [
        { left: 40, right: 140 },
        { left: 140, right: 260 },
        { left: 260, right: 380 },
        { left: 380, right: 500 },
      ]),
    ).toBe(2);
  });

  it("ignores subpixel drift and caps the compact label", () => {
    expect(
      countClippedTabs(
        { left: 100, right: 400 },
        [{ left: 99.5, right: 400.5 }],
      ),
    ).toBe(0);
    expect(formatClippedTabCount(2)).toBe("2");
    expect(formatClippedTabCount(120)).toBe("99");
  });
});
