import { describe, expect, it } from "vitest";
import {
  DEVICE_PRESETS,
  devicePreset,
  fitScaleFor,
  isEmulating,
  RESPONSIVE_DEVICE,
  rotateDevice,
  viewportFor,
} from "./devices";

describe("browser device presets", () => {
  it("falls back to responsive for anything it does not know", () => {
    // A stored id can outlive the preset it named, and a tab that answers with
    // undefined must not emulate a zero-sized viewport.
    expect(devicePreset("iphone-se").id).toBe("iphone-se");
    expect(devicePreset("nokia-3310")).toBe(RESPONSIVE_DEVICE);
    expect(devicePreset(null)).toBe(RESPONSIVE_DEVICE);
    expect(devicePreset(undefined)).toBe(RESPONSIVE_DEVICE);
  });

  it("treats only a sized preset as emulation", () => {
    expect(isEmulating(RESPONSIVE_DEVICE)).toBe(false);
    expect(isEmulating(devicePreset("ipad-air"))).toBe(true);
  });

  it("rotates a device without inventing one for responsive", () => {
    const rotated = rotateDevice(devicePreset("iphone-14-pro"));
    expect([rotated.width, rotated.height]).toEqual([852, 393]);
    expect(rotateDevice(RESPONSIVE_DEVICE)).toBe(RESPONSIVE_DEVICE);
  });

  it("keeps every preset usable by the backend", () => {
    // The command refuses a zero height, a scale outside 0.1..4, or an edge
    // past 10000, so a preset that trips those would fail at the tab.
    const ids = new Set<string>();
    for (const preset of DEVICE_PRESETS) {
      expect(ids.has(preset.id)).toBe(false);
      ids.add(preset.id);
      expect(preset.scale).toBeGreaterThanOrEqual(0.1);
      expect(preset.scale).toBeLessThanOrEqual(4);
      if (preset.width > 0) {
        expect(preset.height).toBeGreaterThan(0);
        expect(preset.width).toBeLessThanOrEqual(10_000);
        expect(preset.height).toBeLessThanOrEqual(10_000);
      }
    }
  });
});

describe("fitting an emulated viewport into the pane", () => {
  it("shrinks a desktop viewport so a narrow pane shows all its width", () => {
    // The pane in a split layout is around 455 CSS pixels wide; a 1920 wide
    // desktop layout has to come down to roughly a quarter to be seen whole
    // instead of cropped at the right edge.
    const desktop = devicePreset("desktop");
    expect(fitScaleFor(desktop, 455)).toBe(0.236);
    expect(fitScaleFor(desktop, 455) * desktop.width).toBeLessThanOrEqual(455);
  });

  it("never enlarges a small device to fill a big pane", () => {
    expect(fitScaleFor(devicePreset("iphone-se"), 1600)).toBe(1);
  });

  it("stays at 1 when nothing is emulated or the pane is unmeasured", () => {
    expect(fitScaleFor(RESPONSIVE_DEVICE, 400)).toBe(1);
    expect(fitScaleFor(devicePreset("desktop"), 0)).toBe(1);
    expect(fitScaleFor(devicePreset("desktop"), Number.NaN)).toBe(1);
  });

  it("keeps every preset inside the range the backend accepts", () => {
    // A collapsed pane must not produce a fit the command rejects.
    for (const preset of DEVICE_PRESETS) {
      const fit = fitScaleFor(preset, 1);
      expect(fit).toBeGreaterThanOrEqual(0.05);
      expect(fit).toBeLessThanOrEqual(1);
    }
  });

  it("grows the emulated height so the page covers the pane", () => {
    // A 16:9 device in a squarer pane would otherwise paint 505 of 735 pixels
    // and leave the rest blank, which is what this replaced.
    const view = viewportFor(devicePreset("desktop"), 899, 735);
    expect(view.width).toBe(1920);
    expect(view.fitScale).toBe(0.468);
    expect(Math.round(view.height * view.fitScale)).toBe(735);
    expect(view.height).toBeGreaterThan(1080);
  });

  it("keeps the device height when the pane is shorter than it", () => {
    const view = viewportFor(devicePreset("iphone-14-pro"), 1200, 400);
    expect(view.width).toBe(393);
    expect(view.fitScale).toBe(1);
    expect(view.height).toBe(852);
  });

  it("never asks for a viewport past the backend limit", () => {
    // A tall pane at a punishing scale must not overflow the 10000 cap.
    const view = viewportFor(devicePreset("desktop"), 30, 900);
    expect(view.height).toBeLessThanOrEqual(10_000);
    expect(view.fitScale).toBeGreaterThanOrEqual(0.05);
  });
});
