import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, "rendererPool.ts"), "utf8");

function sourceBetween(start: string, end: string): string {
  return source.slice(source.indexOf(start), source.indexOf(end));
}

describe("terminal window restore", () => {
  it("does not fit minimized terminal surfaces", () => {
    expect(source).toContain("isWindowPresentationBlocked()");
    expect(source).toContain("canFitTerminal(container)");
  });

  it("refits, resizes, and repaints visible PTYs after restore", () => {
    expect(source).toContain("restoreVisibleSlotsAfterWindowRestore");
    expect(source).toContain("bridge?.resizePty");
    expect(source).toContain("bridge?.kickPty");
    expect(source).toContain("slot.term.refresh");
  });

  it("repaints a parked terminal without invalidating the shared atlas", () => {
    expect(source).toContain("scheduleRevealRepair(slot, leafId)");
    expect(source).toContain("slot.currentLeafId !== leafId || slot.parked");
    expect(source).not.toContain("clearTextureAtlas");
  });

  it("repairs a stale WebGL frame after a visible pane resize settles", () => {
    expect(source).toContain("scheduleWebglFrameRepair(slot, p.leafId)");
    expect(source).toContain("WEBGL_FRAME_REPAIR_DELAY_MS");
    expect(source).toContain("!adapter?.isLeafVisible(leafId)");
  });

  it("does not schedule delayed repaint for an ordinary bind or tab reveal", () => {
    expect(
      sourceBetween("function bindSlot", "function scheduleUnhide"),
    ).not.toContain("scheduleWebglFrameRepair");
    expect(
      sourceBetween(
        "export function refreshLeafSlot",
        "export function disposeLeafSlot",
      ),
    ).not.toContain("scheduleWebglFrameRepair");
  });

  it("gates rewire repair on an actual frame geometry change", () => {
    expect(
      sourceBetween("function rewireSlot", "function setupResizeObserver"),
    ).toContain("shouldRepairWebglFrame");
  });
});
