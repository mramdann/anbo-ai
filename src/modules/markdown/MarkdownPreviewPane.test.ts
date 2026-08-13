import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, "MarkdownPreviewPane.tsx"), "utf8");
const streamdownMatch = src.match(/<Streamdown[\s\S]*?<\/Streamdown>/);
const streamdownJsx = streamdownMatch?.[0] ?? "";

describe("MarkdownPreviewPane Streamdown configuration", () => {
  it("renders complete markdown files in static mode", () => {
    expect(streamdownJsx).toMatch(/mode="static"/);
  });

  it("does not run streaming incomplete-markdown repair for files", () => {
    expect(streamdownJsx).toMatch(/parseIncompleteMarkdown=\{false\}/);
  });

  it("defers file IO until the preview is visible", () => {
    expect(src).toMatch(/if \(!visible \|\| loadedPath\.current === path\) return/);
  });

  it("applies the preview byte limit at the IPC boundary", () => {
    expect(src).toMatch(/maxBytes: MARKDOWN_PREVIEW_MAX_BYTES/);
  });
});
