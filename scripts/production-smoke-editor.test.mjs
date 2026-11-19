import { describe, expect, it, vi } from "vitest";
import {
  editorDeservesAnotherTry,
  readEditorSmoke,
  runEditorSmoke,
} from "./lib/production-smoke-editor.mjs";

// The root element as headless Chrome dumps it.
const dom = (attributes) =>
  `<html lang="en" data-anbo-bundle-ready="true"${Object.entries(attributes)
    .map(([name, value]) => ` data-anbo-editor-smoke${name}="${value}"`)
    .join("")}><head></head><body></body></html>`;

const MARKER_MISSING =
  "CodeMirror layout or stable syntax token did not mount; missing: selectionMarker";
const passedAtOnce = dom({ "": "pass", "-looks": "1" });
const passedLate = dom({ "": "pass", "-looks": "9", "-first-look": MARKER_MISSING });
// What CI printed on Nov 18 2026: every look gone before the selection was drawn.
const markerNeverCame = dom({
  "": "fail",
  "-error": MARKER_MISSING,
  "-looks": "30",
  "-first-look": MARKER_MISSING,
});
const wrongLayout = dom({
  "": "fail",
  "-error": "{&quot;textMatches&quot;:true,&quot;horizontalEditorLayout&quot;:false}",
  "-looks": "30",
});
const noVerdict = dom({});

const quiet = () => ({ log: vi.fn(), warn: vi.fn() });
const pages = (...dumps) => {
  const runPage = vi.fn(async () => ({ stdout: dumps.shift(), stderr: "chrome's own log" }));
  return runPage;
};

describe("the editor page's verdict", () => {
  it("is read from the dumped root element", () => {
    expect(readEditorSmoke(passedAtOnce)).toEqual({
      passed: true,
      looks: "1",
      firstLook: null,
      detail: null,
    });
    expect(readEditorSmoke(markerNeverCame)).toEqual({
      passed: false,
      looks: "30",
      firstLook: MARKER_MISSING,
      detail: MARKER_MISSING,
    });
    expect(readEditorSmoke(noVerdict)).toEqual({
      passed: false,
      looks: null,
      firstLook: null,
      detail: null,
    });
  });

  it("is worth one more run when a part is still missing or nothing was said", () => {
    expect(editorDeservesAnotherTry(readEditorSmoke(markerNeverCame))).toBe(true);
    expect(editorDeservesAnotherTry(readEditorSmoke(noVerdict))).toBe(true);
  });

  it("stands when the editor passed or is there and laid out wrongly", () => {
    expect(editorDeservesAnotherTry(readEditorSmoke(passedAtOnce))).toBe(false);
    expect(editorDeservesAnotherTry(readEditorSmoke(wrongLayout))).toBe(false);
  });
});

describe("the editor smoke", () => {
  it("runs the page once when the editor passes", async () => {
    const runPage = pages(passedAtOnce);
    const log = quiet();
    await expect(runEditorSmoke(runPage, log)).resolves.toMatchObject({
      passed: true,
      looks: "1",
      attempt: 1,
    });
    expect(runPage).toHaveBeenCalledTimes(1);
    expect(runPage).toHaveBeenCalledWith("editor");
    expect(log.log).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("says what a late editor was still waiting for at the first look", async () => {
    const log = quiet();
    await expect(runEditorSmoke(pages(passedLate), log)).resolves.toMatchObject({
      looks: "9",
      attempt: 1,
    });
    expect(log.log).toHaveBeenCalledWith(`editor smoke, first look: ${MARKER_MISSING}`);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("runs the page once more when the selection never came, and takes that verdict", async () => {
    const runPage = pages(markerNeverCame, passedAtOnce);
    const log = quiet();
    await expect(runEditorSmoke(runPage, log)).resolves.toMatchObject({
      passed: true,
      looks: "1",
      attempt: 2,
    });
    expect(runPage).toHaveBeenNthCalledWith(2, "editor, second try");
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      `production editor layout smoke failed: ${MARKER_MISSING} (after 30 looks); trying once more.`,
    );
  });

  it("runs the page once more when it gave no verdict", async () => {
    const runPage = pages(noVerdict, passedLate);
    const log = quiet();
    await expect(runEditorSmoke(runPage, log)).resolves.toMatchObject({ looks: "9", attempt: 2 });
    expect(log.warn).toHaveBeenCalledWith(
      "production editor layout smoke failed: the page gave no verdict; trying once more.",
    );
  });

  it("fails after the second run, with Chrome's log", async () => {
    const runPage = pages(markerNeverCame, markerNeverCame, passedAtOnce);
    await expect(runEditorSmoke(runPage, quiet())).rejects.toThrow(
      `production editor layout smoke failed: ${MARKER_MISSING} (after 30 looks), on the second try too\nchrome's own log`,
    );
    expect(runPage).toHaveBeenCalledTimes(2);
  });

  it("fails at once on a layout that is there and wrong", async () => {
    const runPage = pages(wrongLayout, passedAtOnce);
    const log = quiet();
    await expect(runEditorSmoke(runPage, log)).rejects.toThrow(
      /^production editor layout smoke failed: \{&quot;textMatches&quot;.*\(after 30 looks\)\nchrome's own log$/,
    );
    expect(runPage).toHaveBeenCalledTimes(1);
    expect(log.warn).not.toHaveBeenCalled();
  });
});
