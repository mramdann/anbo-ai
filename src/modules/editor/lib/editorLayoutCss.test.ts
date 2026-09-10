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

describe("terminal scrollbar", () => {
  it("outlasts xterm's auto-hide while the buffer is scrollable", () => {
    // xterm builds the bar with ScrollbarVisibility.Auto, so it swaps in the
    // `invisible fade` classes as soon as the terminal goes quiet and fades the
    // bar to opacity 0. Measured on a real xterm 6 buffer with 400 lines of
    // scrollback: opacity 0.69 mid-transition, 0 once settled. Without these
    // two rules the terminal looks like it has no scrollbar at all.
    expect(css).toMatch(
      /\[data-anbo-terminal-scrollable="true"\][^{]*\.scrollbar\.vertical\s*\{[^}]*opacity:\s*1\s*!important/,
    );
    expect(css).toMatch(
      /\[data-anbo-terminal-scrollable="false"\][^{]*\.scrollbar\.vertical\s*\{[^}]*opacity:\s*0\s*!important/,
    );
  });

  it("survives Tailwind's invisible utility", () => {
    // xterm names its hidden-scrollbar state class `invisible`, and so does
    // Tailwind, whose utility the app really uses -- so the build emits
    // `.invisible{visibility:hidden}` and it lands on xterm's scrollbar, which
    // is class="invisible scrollbar vertical fade". Nothing in xterm's own
    // stylesheet sets visibility, so the bar is taken out of the paint
    // entirely: measured visibility hidden, missing from elementsFromPoint,
    // and no pixels at the slider rect even with opacity forced to 1. This is
    // why the terminal had a bar in dev and none in a packaged build.
    expect(css).toMatch(
      /\.xterm \.xterm-scrollable-element > \.scrollbar \{[^}]*visibility:\s*visible\s*!important/,
    );
  });

  it("leaves the native viewport bar off", () => {
    // xterm 6 scrolls by translating .xterm-scrollable-element, so
    // .xterm-viewport never overflows (scrollHeight === clientHeight). A native
    // bar there reserves a gutter for a thumb that can never be drawn.
    expect(css).toMatch(
      /\.xterm-viewport::-webkit-scrollbar \{[^}]*display:\s*none/,
    );
  });

  it("sizes the bar and its slider from the shared token", () => {
    expect(css).toMatch(
      /\.scrollbar\.vertical\s*\{[^}]*width:\s*var\(--scrollbar-thickness\)/,
    );
    expect(css).toMatch(
      /\.scrollbar\.vertical > \.slider\s*\{[^}]*width:\s*var\(--scrollbar-thickness\)/,
    );
  });
  it("wins on !important rather than on stylesheet order", () => {
    // main.tsx imports xterm.css first and globals.css last, but Vite splits
    // them into separate chunks and index.html loads the chunk carrying
    // xterm.css last in a packaged build -- the reverse of dev. Anything that
    // has to beat xterm's own stylesheet cannot lean on order.
    const block = css.slice(
      css.indexOf(".xterm .scrollbar.horizontal"),
      css.indexOf(".xterm .xterm-decoration-overview-ruler"),
    );
    expect(block.length).toBeGreaterThan(200);
    const weak = (block.match(/^ {2}[a-z-]+:[^;]+;/gm) ?? []).filter(
      (d) => !d.includes("!important") && !d.startsWith("  border-radius"),
    );
    expect(weak).toEqual([]);
  });
});
