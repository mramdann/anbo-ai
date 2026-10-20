import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, "rendererPool.ts"), "utf8");
const sessionSource = readFileSync(
  path.join(here, "useTerminalSession.ts"),
  "utf8",
);

function sourceBetween(start: string, end: string): string {
  return source.slice(source.indexOf(start), source.indexOf(end));
}

describe("terminal window restore", () => {
  it("never evicts a bound buffer before the asynchronous idle check releases it", () => {
    const protection = sourceBetween(
      "function protectedBuffer",
      "function pickSlotFor",
    );
    expect(protection).toContain("s.currentLeafId !== null");
    expect(protection).toContain("s.pendingWrites > 0");
    expect(protection).toContain("s.currentLeafId ?? s.retainedLeafId");
  });
  it("does not fit minimized terminal surfaces", () => {
    expect(source).toContain("isWindowPresentationBlocked()");
    expect(source).toContain("canFitTerminal(container)");
  });

  it("refits and repaints visible terminals after restore, resizing a PTY only when its grid changed", () => {
    // Every PTY size change makes the shell or TUI draw again, and a shell
    // leaves its old prompt in the scrollback each time: a restore never
    // bumps a PTY, and resizes it only to a grid it was not told yet.
    expect(source).toContain("refitVisibleSlots(true)");
    const refit = sourceBetween(
      "function refitVisibleSlots",
      "export function refitVisibleTerminalSlots",
    );
    const restoredAt = refit.indexOf("if (windowRestored) {");
    const otherwiseAt = refit.indexOf("} else {", restoredAt);
    expect(restoredAt).toBeGreaterThan(-1);
    expect(otherwiseAt).toBeGreaterThan(restoredAt);
    const restored = refit.slice(restoredAt, otherwiseAt);
    expect(restored).toContain("syncPtySize(slot, leafId)");
    expect(restored).not.toContain("resizePty");
    expect(refit.slice(otherwiseAt)).toContain("resizePty(");
    expect(refit).not.toContain("kickPty");
    expect(refit).toContain("scheduleWebglFrameRepair(slot, leafId)");
    expect(refit).toContain("repaintSlot(slot)");
    expect(
      sourceBetween("function syncPtySize", "function cancelRevealRepair"),
    ).toContain(
      "slot.term.cols === slot.lastCols && slot.term.rows === slot.lastRows",
    );
    expect(source).toContain("slot.term.refresh");
  });

  it("tells the PTY a resize its debounce still held when a terminal leaves its slot", () => {
    // releaseSlot reports the grid the leaf leaves with as the PTY's size.
    // Dropping the debounced resize left the PTY at its old size while the
    // session reported the new one, until a later layout refit resized it.
    const detach = sourceBetween(
      "function detachSlotFromLeaf",
      "function parkSlotHost",
    );
    const flushAt = detach.indexOf("syncPtySize(slot, slot.currentLeafId)");
    expect(flushAt).toBeGreaterThan(
      detach.indexOf("clearTimeout(slot.ptyTimer)"),
    );
    expect(flushAt).toBeLessThan(detach.indexOf("slot.currentLeafId = null"));
    expect(
      sourceBetween("export function releaseSlot", "export function writeSlot"),
    ).toContain("return { cols: slot.term.cols, rows: slot.term.rows }");
  });

  it("repaints a parked terminal without invalidating the shared atlas", () => {
    expect(source).toContain("scheduleRevealRepair(slot, leafId)");
    expect(source).toContain("slot.currentLeafId !== leafId || slot.parked");
    expect(
      sourceBetween(
        "function scheduleRevealRepair",
        "function cancelRevealRepair",
      ),
    ).not.toContain("clearTextureAtlas");
  });

  it("drops cached glyphs once the document finishes loading fonts", () => {
    // A glyph drawn while its face was unavailable is drawn with the fallback
    // face and cached; nothing but a fresh rasterization ever corrects it.
    expect(source).toContain(
      'document.fonts.addEventListener("loadingdone", refreshGlyphsAfterFontLoad)',
    );
    const refresh = sourceBetween(
      "function refreshGlyphsAfterFontLoad",
      "function requestTerminalFont",
    );
    expect(refresh).toContain("slot.term.clearTextureAtlas()");
    expect(refresh).toContain("slot.term.refresh(0, slot.term.rows - 1)");
    // Attaching a renderer asks for the font, so a declared-but-unloaded face
    // is fetched instead of substituted.
    expect(
      sourceBetween("function attachWebgl", "function disposeSlotWebgl"),
    ).toContain("requestTerminalFont(slot.term)");
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

  it("registers OSC handlers before replaying dormant terminal bytes", () => {
    const bind = sourceBetween("function bindSlot", "function scheduleUnhide");
    expect(
      bind.indexOf("slot.oscDisposers = p.registerOsc(slot.term)"),
    ).toBeLessThan(
      bind.indexOf("p.drainRing((bytes) => writeSlot(slot, bytes))"),
    );
  });

  it("cancels a stale hidden-release timer before automation binds", () => {
    const start = sessionSource.indexOf(
      "export function prepareTerminalAutomationSession",
    );
    const end = sessionSource.indexOf(
      "export async function writeToReadySession",
    );
    const prepare = sessionSource.slice(start, end);
    expect(prepare.indexOf("cancelHiddenRelease(session)")).toBeLessThan(
      prepare.indexOf("bindLeafToSlot(leafId, session)"),
    );
  });

  it("gates rewire repair on an actual frame geometry change", () => {
    expect(
      sourceBetween("function rewireSlot", "function setupResizeObserver"),
    ).toContain("shouldRepairWebglFrame");
  });

  it("fits only shown terminals, and a hidden one parses at its PTY's size", () => {
    // Measured in the 24 h soak: a hidden workspace's terminal bound for an agent
    // took its hidden host's box (the shown workspace's dock), so its PTY went to
    // 81x24, 81x50 or 102x24, output lost 6 characters at column 81 and every
    // TUI redrew its whole history when the workspace was shown again.
    const bind = sourceBetween("function bindSlot", "function scheduleUnhide");
    expect(bind).toContain(
      "if (adapter?.isLeafVisible(p.leafId) && canFitTerminal(p.container)) {",
    );
    expect(bind).not.toContain(
      "if (canFitTerminal(p.container)) slot.fitAddon.fit();",
    );
    const retained = bind.slice(bind.indexOf("// The ring holds"));
    expect(retained.indexOf("slot.term.resize(p.cols, p.rows)")).toBeLessThan(
      retained.indexOf("p.drainRing((bytes) => writeSlot(slot, bytes))"),
    );
    const rewire = sourceBetween(
      "function rewireSlot",
      "function setupResizeObserver",
    );
    expect(rewire).toContain("if (adapter?.isLeafVisible(p.leafId)) {");
    expect(rewire).toContain("slot.term.resize(p.cols, p.rows)");
    expect(
      sourceBetween("function setupResizeObserver", "type SerializeOutput"),
    ).toContain("!adapter?.isLeafVisible(p.leafId)");
    expect(
      sourceBetween("function refitSlot", "export function applyLetterSpacing"),
    ).toContain("!adapter?.isLeafVisible(slot.currentLeafId)");
    expect(
      sourceBetween("function scheduleRevealRepair", "function repaintSlot"),
    ).toContain("adapter?.isLeafVisible(leafId)");
    const open = sessionSource.slice(
      sessionSource.indexOf("async function openPtyForSession"),
      sessionSource.indexOf("function applyBlockMode"),
    );
    expect(open).toContain("s.cols = startCols;");
  });
});
