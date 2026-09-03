import { describe, expect, it } from "vitest";
import { calculateVoiceBands, normalizeVoiceLevel } from "./audioMeter";

describe("voice audio meter", () => {
  it("keeps ambient noise still and maps speech energy into the visual range", () => {
    expect(normalizeVoiceLevel(0)).toBe(0);
    expect(normalizeVoiceLevel(0.01)).toBe(0);
    expect(normalizeVoiceLevel(0.08)).toBeGreaterThan(0.4);
    expect(normalizeVoiceLevel(1)).toBe(1);
  });

  it("returns bounded frequency bands weighted by the current voice level", () => {
    const data = new Uint8Array(128).fill(180);
    const quiet = calculateVoiceBands(data, 48_000, 256, 0);
    const speaking = calculateVoiceBands(data, 48_000, 256, 0.8);

    expect(quiet).toHaveLength(5);
    expect(speaking.every((value) => value >= 0 && value <= 1)).toBe(true);
    expect(speaking[2]).toBeGreaterThan(quiet[2]);
  });

  it("returns silence for invalid analyser geometry", () => {
    expect(calculateVoiceBands(new Uint8Array(), 48_000, 256, 1)).toEqual([
      0, 0, 0, 0, 0,
    ]);
  });
});
