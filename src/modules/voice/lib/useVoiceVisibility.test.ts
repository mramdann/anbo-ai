import { describe, expect, it } from "vitest";
import { orbOnScreen, orbVisibleFromStorage } from "./useVoiceVisibility";

describe("orbVisibleFromStorage", () => {
  it("shows the orb unless it was explicitly hidden", () => {
    expect(orbVisibleFromStorage(null)).toBe(true);
    expect(orbVisibleFromStorage("1")).toBe(true);
    expect(orbVisibleFromStorage("")).toBe(true);
    expect(orbVisibleFromStorage("0")).toBe(false);
  });
});

describe("orbOnScreen", () => {
  it("follows the header toggle while the orb is idle", () => {
    expect(orbOnScreen("1", false)).toBe(true);
    expect(orbOnScreen(null, false)).toBe(true);
    expect(orbOnScreen("0", false)).toBe(false);
  });

  it("keeps a hidden orb on screen while it is needed", () => {
    expect(orbOnScreen("0", true)).toBe(true);
    expect(orbOnScreen("1", true)).toBe(true);
  });
});
