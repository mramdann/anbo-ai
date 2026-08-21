import { describe, expect, it } from "vitest";
import { shouldShowTerminalScrollbar } from "./scrollbarVisibility";

describe("shouldShowTerminalScrollbar", () => {
  it("hides the scrollbar when the normal buffer has no scrollback", () => {
    expect(shouldShowTerminalScrollbar({ type: "normal", baseY: 0 })).toBe(
      false,
    );
  });

  it("shows the scrollbar when the normal buffer has scrollback", () => {
    expect(shouldShowTerminalScrollbar({ type: "normal", baseY: 12 })).toBe(
      true,
    );
  });

  it("hides the scrollbar for alternate-screen applications", () => {
    expect(shouldShowTerminalScrollbar({ type: "alternate", baseY: 12 })).toBe(
      false,
    );
  });
});
