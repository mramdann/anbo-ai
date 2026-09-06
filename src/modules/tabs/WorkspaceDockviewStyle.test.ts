import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const css = readFileSync(path.join(here, "WorkspaceDockview.css"), "utf8");

describe("WorkspaceDockview active tab treatment", () => {
  it("uses theme tokens and curved shoulders for a Chrome-style active tab", () => {
    expect(css).toContain("--anbo-chrome-tab-surface");
    expect(css).toContain(".anbo-workspace-dockview-tab::before");
    expect(css).toContain(".anbo-workspace-dockview-tab::after");
    // The shoulders are gradients, not shadows cast from rounded boxes: the
    // shadow trick left seams wherever the UI zoom made pixels fractional.
    expect(css).toContain("circle at 0 0");
    expect(css).toContain("circle at 100% 0");
    expect(css).not.toContain("box-shadow: 4px 4px 0 4px");
    expect(css).not.toContain("box-shadow: -4px 4px 0 4px");
    expect(css).toContain("var(--terminal-background)");
    expect(css).toContain('data-workspace-dockview-tab-kind="browser"');
    expect(css).toContain("0 2px 0 var(--anbo-chrome-tab-surface)");
    expect(css).toContain("var(--primary)");
    expect(css).toContain("var(--background)");
    expect(css).toContain("var(--card)");
  });

  it("keeps browser automation motion accessible", () => {
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain("animation: none");
  });

  it("dresses the active tab of the focused group only", () => {
    // Surface, shoulders, bridge, accent line and glow all hang off the
    // focused group; an active tab in any other group looks like any other
    // tab, and the panel beneath it says what it shows.
    const dressing = ".dv-tab.dv-active-tab\n  .anbo-workspace-dockview-tab";
    const focusedPrefix =
      ".dv-groupview.dv-active-group\n  > .dv-tabs-and-actions-container\n  " +
      dressing;
    expect(css).toContain(focusedPrefix);
    expect(css.split(dressing).length - 1).toBe(
      css.split(focusedPrefix).length - 1,
    );
    expect(css).toContain("border-top: 2px solid var(--primary)");
    expect(css).toContain("0 2px 0 var(--anbo-chrome-tab-surface)");
    expect(css).not.toContain("inset 0 1px 0 color-mix");
  });

  it("gives the accent line, glow and pulse only to the focused group, and holds still under reduced motion", () => {
    expect(css).toContain("@keyframes anbo-workspace-active-tab-focus-pulse");
    expect(css).toContain(".dv-groupview.dv-active-group");
    expect(css).toContain(
      "animation: anbo-workspace-active-tab-focus-pulse 1.8s ease-in-out infinite",
    );
    // Focus is still legible without motion: the line at full strength.
    expect(css).toMatch(
      /animation: none;\s*border-top-color: var\(--primary\)/,
    );
  });

  it("animates the browser automation robot with a reduced-motion fallback", () => {
    expect(css).toContain("@keyframes anbo-browser-automation-robot-hop");
    expect(css).toContain(".anbo-browser-automation-robot");
    expect(css).toContain("transform-origin: center bottom");
  });
});
