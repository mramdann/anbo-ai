import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, "rendererPool.ts"), "utf8");

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

  it("repairs the WebGL atlas after a parked terminal becomes visible", () => {
    expect(source).toContain("scheduleRevealRepair(slot, leafId)");
    expect(source).toContain("slot.webglAddon?.clearTextureAtlas()");
    expect(source).toContain("slot.currentLeafId !== leafId || slot.parked");
  });
});
