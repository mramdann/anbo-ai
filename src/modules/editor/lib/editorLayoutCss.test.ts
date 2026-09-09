import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const css = readFileSync(
  path.resolve(here, "../../../styles/globals.css"),
  "utf8",
);

describe("CodeMirror layout fallback", () => {
  it("mirrors the editor height, not only its flex direction", () => {
    // Without a definite height the scroller grows to the whole document, so
    // it never overflows, no scrollbar is drawn, and the wrapper clips the
    // rest. That is what a delayed or de-duplicated style-mod theme causes in
    // a production build.
    // The pane is a flex item: it has a used height but its computed height is
    // auto, so a percentage on the child cannot resolve. The editor has to take
    // its box from flex instead.
    expect(css).toMatch(
      /\.anbo-code-editor \{[^}]*display:\s*flex[^}]*flex-direction:\s*column/,
    );
    expect(css).toMatch(
      /\.anbo-code-editor > \.cm-editor \{[^}]*flex:\s*1 1 auto[^}]*min-height:\s*0/,
    );
  });

  it("keeps the scroller mirror that the height depends on", () => {
    expect(css).toMatch(/\.cm-scroller \{[^}]*height:\s*100%/);
    expect(css).toMatch(/\.cm-scroller \{[^}]*overflow-x:\s*auto/);
  });

  it("leaves the editor scrollbar opt-in on the initial standard values", () => {
    // Chromium ignores ::-webkit-scrollbar on any element whose scrollbar-width
    // or scrollbar-color is non-initial, so these two must stay auto.
    expect(css).toMatch(
      /\.anbo-code-editor \.cm-scroller \{\s*scrollbar-width:\s*auto;\s*scrollbar-color:\s*auto;\s*\}/,
    );
  });
});

describe("scrollbar opt-ins", () => {
  // The global hider sets display:none on every ::-webkit-scrollbar, so any
  // surface that wants one back has to restate display. A rule that only sets
  // a width paints nothing, which is exactly how the terminal lost its bar.
  const optIns = [
    /\.panel-scrollbar::-webkit-scrollbar \{[^}]*display:\s*block/,
    /\.anbo-code-editor \.cm-scroller::-webkit-scrollbar \{[^}]*display:\s*block/,
    /\.xterm-viewport::-webkit-scrollbar \{[^}]*display:\s*block/,
  ];

  it.each(optIns)("restates display so the hider cannot win: %s", (pattern) => {
    expect(css).toMatch(pattern);
  });

  it("keeps every opt-in on the shared thickness token", () => {
    const widths = css.match(/::-webkit-scrollbar \{[^}]*width:[^;]+/g) ?? [];
    const opted = widths.filter((w) => !w.includes("width: 0"));
    expect(opted.length).toBeGreaterThan(0);
    for (const w of opted) {
      expect(w).toContain("var(--scrollbar-thickness)");
    }
  });
});
