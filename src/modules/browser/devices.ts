/** A viewport the browser can pretend to be. */
export type DevicePreset = {
  id: string;
  label: string;
  /** CSS pixels the page lays out in. Zero width means no emulation. */
  width: number;
  height: number;
  /** Device pixel ratio the page reads back. */
  scale: number;
  /** Drives touch emulation and the `mobile` flag sites branch on. */
  mobile: boolean;
};

export const RESPONSIVE_DEVICE: DevicePreset = {
  id: "responsive",
  label: "Responsive",
  width: 0,
  height: 0,
  scale: 1,
  mobile: false,
};

// Sizes are the CSS viewport each device reports, not its physical panel: a
// 14 Pro is 1179 physical pixels across but lays out at 393.
export const DEVICE_PRESETS: DevicePreset[] = [
  RESPONSIVE_DEVICE,
  {
    id: "iphone-se",
    label: "iPhone SE",
    width: 375,
    height: 667,
    scale: 2,
    mobile: true,
  },
  {
    id: "iphone-14-pro",
    label: "iPhone 14 Pro",
    width: 393,
    height: 852,
    scale: 3,
    mobile: true,
  },
  {
    id: "pixel-7",
    label: "Pixel 7",
    width: 412,
    height: 915,
    scale: 2.625,
    mobile: true,
  },
  {
    id: "ipad-air",
    label: "iPad Air",
    width: 820,
    height: 1180,
    scale: 2,
    mobile: true,
  },
  {
    id: "laptop",
    label: "Laptop",
    width: 1280,
    height: 800,
    scale: 1,
    mobile: false,
  },
  {
    id: "desktop",
    label: "Desktop",
    width: 1920,
    height: 1080,
    scale: 1,
    mobile: false,
  },
];

export function devicePreset(id: string | null | undefined): DevicePreset {
  if (!id) return RESPONSIVE_DEVICE;
  return (
    DEVICE_PRESETS.find((preset) => preset.id === id) ?? RESPONSIVE_DEVICE
  );
}

export function isEmulating(preset: DevicePreset): boolean {
  return preset.width > 0 && preset.height > 0;
}

/** Swap the long and short edges of an emulated device. */
export function rotateDevice(preset: DevicePreset): DevicePreset {
  if (!isEmulating(preset)) return preset;
  return { ...preset, width: preset.height, height: preset.width };
}

/**
 * How much the painted result must shrink for the emulated width to be seen
 * whole in a pane of `paneWidth` CSS pixels.
 *
 * Width alone decides it. Honouring the device's height as well would letterbox
 * a 16:9 desktop inside a squarer pane and leave a third of it blank, and the
 * height is the one dimension a page can simply scroll.
 *
 * Never above 1: a phone viewport in a wide pane stays its own size rather than
 * being blown up, which is what a device preview is for.
 */
export function fitScaleFor(preset: DevicePreset, paneWidth: number): number {
  if (!isEmulating(preset)) return 1;
  if (!(paneWidth > 0)) return 1;
  // Round down, never up: rounding 455/1920 to 0.237 would lay the page out
  // 455.04 pixels wide and crop the last sliver, which is the whole thing this
  // is meant to prevent. The backend refuses anything below 0.05, and a pane
  // that small is being collapsed rather than looked at.
  return Math.max(0.05, Math.floor(Math.min(1, paneWidth / preset.width) * 1000) / 1000);
}

/** Tallest viewport we will ask for, matching the backend's own limit. */
const MAX_VIEWPORT_EDGE = 10_000;

/**
 * The viewport to emulate in a pane of this size: the device's width, and
 * whatever height covers the pane at the resulting scale, so the page fills
 * the tab instead of ending in blank space partway down.
 */
export function viewportFor(
  preset: DevicePreset,
  paneWidth: number,
  paneHeight: number,
): {
  width: number;
  height: number;
  scale: number;
  mobile: boolean;
  fitScale: number;
} {
  const fitScale = fitScaleFor(preset, paneWidth);
  const covering = paneHeight > 0 ? Math.round(paneHeight / fitScale) : 0;
  const height = Math.min(
    MAX_VIEWPORT_EDGE,
    Math.max(preset.height, covering) || preset.height,
  );
  return {
    width: preset.width,
    height,
    scale: preset.scale,
    mobile: preset.mobile,
    fitScale,
  };
}
