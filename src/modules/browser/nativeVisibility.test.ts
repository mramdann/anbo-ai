import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { rectsIntersect } from "./nativeVisibility";

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
    expect(source).toContain("const LAYOUT_FALLBACK_MS = 1_500");
  });

  it("does not observe the entire application DOM", () => {
    expect(source).not.toContain("MutationObserver");
    expect(source).not.toContain("subtree: true");
  });
});
