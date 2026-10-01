import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  cornerRadius,
  FLOATING_SURFACE_SELECTOR,
  MAX_FLOATING_SURFACES,
  rectsIntersect,
  surfaceHole,
  TOAST_DROP_HOLD_MS,
  toastRemovalDropsStack,
} from "./nativeVisibility";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, "nativeVisibility.ts"), "utf8");

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

describe("native browser overlay overlap", () => {
  it("ignores dropdowns outside the browser", () => {
    expect(rectsIntersect(rect(0, 0, 100, 30), rect(0, 40, 500, 400))).toBe(
      false,
    );
  });

  it("detects overlays that cover part of the browser", () => {
    expect(rectsIntersect(rect(20, 20, 200, 100), rect(0, 40, 500, 400))).toBe(
      true,
    );
  });
});

describe("native browser layout signals", () => {
  it("uses event-driven signals and a low-frequency fallback", () => {
    expect(source).toContain('window.addEventListener("resize"');
    expect(source).toContain('window.addEventListener("scroll"');
    expect(source).toContain('document.addEventListener("pointermove"');
    expect(source).toContain('document.addEventListener("visibilitychange"');
    expect(source).toContain("subscribeWindowPresentation");
    expect(source).toContain("const LAYOUT_FALLBACK_MS = 1_500");
  });

  it("does not observe the entire application DOM", () => {
    expect(source).not.toContain("MutationObserver");
    expect(source).not.toContain("subtree: true");
  });

  it("keeps AnboVoice above the native browser through a punch hole", () => {
    expect(source).toContain("[data-anbo-voice-overlay]");
    expect(source).toContain("isPersistentFloatingSurface");
  });

  it("keeps toasts still over a native page and lets them leave in place", () => {
    const css = readFileSync(
      path.join(here, "../../styles/globals.css"),
      "utf8",
    );
    // Embedded and docked pages alike.
    const live =
      ':is(html[data-native-browser-live="true"], html[data-native-dock-live="true"])';
    const rule = (selector: string) =>
      css.slice(css.indexOf(selector), css.indexOf("}", css.indexOf(selector)));
    expect(rule(`${live}\n  [data-sonner-toast],`)).toMatch(
      /> \* \{\s*transition: none !important;\s*animation: none !important;/,
    );
    // A leaving or dropped toast holds its place, opaque, while its cut closes.
    expect(
      rule(
        `${live}\n  [data-sonner-toast]:is([data-removed="true"], [data-visible="false"])`,
      ),
    ).toMatch(
      /transition:\s*transform 0s linear 200ms,\s*opacity 0s linear 200ms !important;/,
    );
    expect(
      rule(`${live}\n  [data-sonner-toast][data-removed="true"]`),
    ).toContain("z-index: 0 !important;");
  });

  it("hears toasts come and go without any transition to announce them", () => {
    const toaster = readFileSync(
      path.join(here, "../../components/ui/sonner.tsx"),
      "utf8",
    );
    expect(toaster).toContain("trackToasterChanges(records)");
    expect(toaster).toContain("observer.observe(element");
    expect(toaster).not.toContain("document.body");
    const track = source.slice(
      source.indexOf("export function trackToasterChanges"),
      source.indexOf("function toastsHoldPageBelow"),
    );
    expect(track).toContain("notifyNativeBrowserLayout();");
  });
});

describe("toasts that drop over an embedded page", () => {
  const toast = (index: number, removed = false, visible = true) => ({
    index,
    removed,
    visible,
  });

  it("drops the stack only when an older toast on screen sits above", () => {
    const stack = [toast(0), toast(1, true), toast(2), toast(3)];
    expect(toastRemovalDropsStack(1, stack)).toBe(true);
    // The oldest leaving moves nothing, and neither do toasts already leaving
    // or hidden past visibleToasts.
    expect(toastRemovalDropsStack(3, stack)).toBe(false);
    expect(
      toastRemovalDropsStack(0, [
        toast(0, true),
        toast(1, true),
        toast(4, false, false),
      ]),
    ).toBe(false);
  });

  it("sinks the page under the pointer and around a drop, for embedded pages only", () => {
    expect(source).toContain(
      'document.addEventListener("pointerover", onPointerOver, true)',
    );
    expect(source).toContain(
      'document.addEventListener("pointerout", onPointerOut, true)',
    );
    expect(source).toContain(
      'document.removeEventListener("pointerover", onPointerOver, true)',
    );
    expect(source).toContain(
      'document.removeEventListener("pointerout", onPointerOut, true)',
    );
    expect(source).toContain(
      "toastsHoldPageBelow(target) || hasNativeBrowserOverlay(target)",
    );
    // The docked browser shows its own page through a leaving toast's slot, so
    // its overlay check stays as it was.
    const overlay = source.slice(
      source.indexOf("export function hasNativeBrowserOverlay"),
      source.indexOf("// A cut reaches the screen"),
    );
    expect(overlay).not.toContain("toastsHoldPageBelow");
  });

  it("keeps a leaving toast cut until the stack drops over it", () => {
    // Closed at once, the page would cover the toast a frame before the page
    // sinks and Anbo draws it again.
    expect(source).toContain(
      "stackDropping ? DROPPING_SURFACE_SELECTOR : FLOATING_SURFACE_SELECTOR",
    );
    expect(source).toContain(
      `'[data-sonner-toast][data-visible="true"][data-removed="true"]'`,
    );
    const drop = source.slice(
      source.indexOf('record.attributeName === "data-removed"'),
      source.indexOf('record.attributeName === "data-mounted"'),
    );
    expect(drop).toContain("stackDropping = true;");
    // The pointer leaving must not cut a drop's longer hold short.
    expect(source).toContain(
      "if (toastSettleTimer && at <= toastsSettleAt) return;",
    );
  });

  it("holds a drop the pointer did not cause until the page has sunk", () => {
    const css = readFileSync(
      path.join(here, "../../styles/globals.css"),
      "utf8",
    );
    const selector =
      'html[data-native-browser-live="true"]\n  [data-sonner-toaster]:not(:hover)\n  [data-sonner-toast][data-anbo-settled]:not([data-removed="true"]):not(\n    [data-visible="false"]\n  )';
    const at = css.indexOf(selector);
    expect(at).toBeGreaterThan(-1);
    expect(css.slice(at, css.indexOf("}", at))).toMatch(
      new RegExp(
        `transform 0s linear ${TOAST_DROP_HOLD_MS}ms,\\s*opacity 0s linear ${TOAST_DROP_HOLD_MS}ms !important;`,
      ),
    );
  });
});

describe("floating surfaces over a native page", () => {
  const pane = rect(100, 50, 800, 600);

  it("keeps toasts on screen and their close buttons above the page", () => {
    expect(FLOATING_SURFACE_SELECTOR).toContain(
      '[data-sonner-toast][data-visible="true"]:not([data-removed="true"])',
    );
    expect(FLOATING_SURFACE_SELECTOR).toContain(
      ':not([data-removed="true"]) [data-close-button]',
    );
    expect(FLOATING_SURFACE_SELECTOR).toContain("[data-ai-mini-window]");
    expect(FLOATING_SURFACE_SELECTOR).toContain("[data-anbo-voice-overlay]");
  });

  it("never sends more holes than the backend accepts", () => {
    const rust = (file: string) =>
      readFileSync(
        path.join(here, "../../../src-tauri/src/modules", file),
        "utf8",
      );
    expect(rust("browser/embed.rs")).toContain(
      `const MAX_PUNCH_HOLES: usize = ${MAX_FLOATING_SURFACES};`,
    );
    expect(rust("browser_external/dock.rs")).toContain(
      `const MAX_CUTOUTS: usize = ${MAX_FLOATING_SURFACES};`,
    );
  });

  it("cuts a toast where it is drawn, as round as it is", () => {
    // 356 x 64 CSS pixels with a 10 px radius, at 125% scaling. Its top and
    // bottom fall on half pixels, which stay page.
    expect(surfaceHole(pane, rect(520, 560, 356, 64), 10, 1.25)).toEqual({
      x: 525,
      y: 638,
      width: 445,
      height: 79,
      radius: 13,
    });
  });

  it("sends a surface whole when it hangs past the pane", () => {
    expect(surfaceHole(pane, rect(60, 100, 300, 200), 16, 1)).toEqual({
      x: -40,
      y: 50,
      width: 300,
      height: 200,
      radius: 16,
    });
  });

  it("opens no pixel a surface only partly paints", () => {
    expect(surfaceHole(pane, rect(100.4, 50.4, 10.2, 10.2), 0, 1)).toEqual({
      x: 1,
      y: 1,
      width: 9,
      height: 9,
      radius: 0,
    });
    // Float noise on a whole pixel is still that pixel.
    expect(
      surfaceHole(pane, rect(120.000001, 69.999999, 40, 20), 0, 1),
    ).toEqual({ x: 20, y: 20, width: 40, height: 20, radius: 0 });
  });

  it("skips surfaces that miss the pane", () => {
    expect(surfaceHole(pane, rect(0, 0, 50, 50), 8, 1)).toBeNull();
  });

  it("reads corner radii as drawn", () => {
    expect(cornerRadius("10px", 356, 64)).toBe(10);
    // Sonner's close button is a circle: 50% of a 20 px square.
    expect(cornerRadius("50%", 20, 20)).toBe(10);
    // A pill's radius is huge and stops at half its height.
    expect(cornerRadius("3.35544e+07px", 104, 32)).toBe(16);
    expect(cornerRadius("8px", 200, 100, 1.25)).toBe(10);
    expect(cornerRadius("0px", 50, 50)).toBe(0);
    expect(cornerRadius("", 50, 50)).toBe(0);
  });
});
