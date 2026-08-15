import { describe, expect, it } from "vitest";
import {
  isPlausibleStableViewport,
  shouldSuspendWindowPresentation,
} from "./windowPresentation";

describe("window presentation policy", () => {
  it("suspends layout measurement while minimized or document-hidden", () => {
    expect(shouldSuspendWindowPresentation(false, false)).toBe(false);
    expect(shouldSuspendWindowPresentation(true, false)).toBe(true);
    expect(shouldSuspendWindowPresentation(false, true)).toBe(true);
  });

  it("does not replace stable geometry with a thumbnail-sized transition", () => {
    expect(isPlausibleStableViewport(1200, 800, 0, 0)).toBe(true);
    expect(isPlausibleStableViewport(1100, 720, 1200, 800)).toBe(true);
    expect(isPlausibleStableViewport(420, 240, 1200, 800)).toBe(false);
    expect(isPlausibleStableViewport(1200, 0, 1200, 800)).toBe(false);
  });
});
