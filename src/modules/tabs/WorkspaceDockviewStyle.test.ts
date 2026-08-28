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
    expect(css).toContain("border-bottom-right-radius: 8px");
    expect(css).toContain("border-bottom-left-radius: 8px");
    expect(css).toContain(
      "box-shadow: 4px 4px 0 4px var(--anbo-chrome-tab-surface)",
    );
    expect(css).toContain(
      "box-shadow: -4px 4px 0 4px var(--anbo-chrome-tab-surface)",
    );
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

  it("pulses the focused tab without changing its surface color", () => {
    expect(css).toContain("@keyframes anbo-workspace-active-tab-focus-pulse");
    expect(css).toContain("var(--anbo-chrome-tab-surface)");
    expect(css).toContain("var(--primary)");
  });

  it("animates the browser automation robot with a reduced-motion fallback", () => {
    expect(css).toContain("@keyframes anbo-browser-automation-robot-hop");
    expect(css).toContain(".anbo-browser-automation-robot");
    expect(css).toContain("transform-origin: center bottom");
  });
});
