import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(path.resolve("src/styles/globals.css"), "utf8");
const pane = readFileSync(
  path.resolve("src/modules/browser/BrowserPane.tsx"),
  "utf8",
);

describe("live native browser overlays", () => {
  it("keeps the browser live beneath the transparent React surface", () => {
    expect(pane).toContain("browserEmbedSetUiOverlay");
    expect(pane).toContain("nativeBrowserLive");
    expect(css).toContain('html[data-native-browser-live="true"] #root');
    expect(css).toContain("--dv-group-view-background-color: transparent");
  });
});
