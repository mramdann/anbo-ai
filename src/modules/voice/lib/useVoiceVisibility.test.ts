import { describe, expect, it } from "vitest";
import { orbVisibleFromStorage } from "./useVoiceVisibility";

describe("orbVisibleFromStorage", () => {
  it("shows the orb unless it was explicitly hidden", () => {
    expect(orbVisibleFromStorage(null)).toBe(true);
    expect(orbVisibleFromStorage("1")).toBe(true);
    expect(orbVisibleFromStorage("")).toBe(true);
    expect(orbVisibleFromStorage("0")).toBe(false);
  });
});
