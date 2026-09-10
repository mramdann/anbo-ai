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
    // The swing has to be wide enough to read against a near-monochrome
    // primary: a narrow one animates but looks static.
    expect(css).toContain(
      "border-top-color: color-mix(in oklab, var(--primary) 32%, transparent)",
    );
    expect(css).toContain(
      "0 -1px 10px color-mix(in oklab, var(--primary) 46%, transparent)",
    );
  });

  it("keeps the agent logo still while two circular waves expand outwards", () => {
    expect(css).not.toContain("anbo-browser-automation-robot-hop");
    expect(css).not.toContain("transform-origin: center bottom");
    expect(css).toContain("@keyframes anbo-browser-automation-pulse");
    // Starts inside the logo and travels outwards, so the wave appears from
    // behind the mark instead of being drawn around it.
    expect(css).toContain("transform: scale(0.45)");
    expect(css).toContain("transform: scale(1.7)");
    // The band has to be near its full strength while it crosses open space,
    // or the beat reads as a flicker at the edge of the logo rather than a
    // wave anyone notices from across the strip.
    const pulse =
      /@keyframes anbo-browser-automation-pulse \{([\s\S]*?)\n\}/.exec(
        css,
      )?.[1] ?? "";
    const opacities = [...pulse.matchAll(/opacity:\s*([\d.]+)/g)].map((match) =>
      Number.parseFloat(match[1]),
    );
    expect(Math.max(...opacities)).toBeGreaterThanOrEqual(0.9);
    // And it must still leave: a wave that never returns to zero is a ring.
    expect(Math.min(...opacities)).toBe(0);
    // A soft gradient band, never a hard outline.
    expect(css).toMatch(/indicator::before[\s\S]{0,400}radial-gradient\(/);
    // The logo carries no filled chip: activity is the wave, not a badge.
    expect(css).not.toMatch(
      /\.anbo-browser-automation-indicator \{[^}]*background:/,
    );
    expect(css).not.toMatch(
      /\.anbo-browser-automation-indicator \{[^}]*box-shadow:/,
    );
    expect(css).not.toMatch(
      /indicator::before,\s*\.anbo-browser-automation-indicator::after\s*\{[^}]*border:\s*1px solid/,
    );
    expect(css).toMatch(
      /indicator::before,\s*\.anbo-browser-automation-indicator::after/,
    );
    // The second wave still starts half a period in, but the period is a token
    // now, because the two session levels below run at different speeds.
    expect(css).toContain(
      "animation-delay: calc(var(--anbo-automation-period, 1.8s) / -2)",
    );
    expect(css).toContain("border-radius: 50%");
  });

  it("beats for the whole session and says which tab is being worked", () => {
    // One agent can hold several tabs at once. Stopping the wave when a call
    // finished made every held tab look finished, and made all of them look
    // alike, so the strip could not answer the only question it is there for:
    // which tab is the agent in right now. Phase picks the level; it must not
    // switch the wave off. Ending the session unmounts the indicator instead.
    expect(css).not.toMatch(
      /indicator\[data-phase="(?:done|error)"\]::(?:before|after)/,
    );
    expect(css).toMatch(
      /indicator\[data-state="held"\] \{[^}]*--anbo-automation-period:/,
    );
    expect(css).toMatch(
      /indicator\[data-state="held"\] \{[^}]*--anbo-automation-wave:/,
    );
    // The held level has to be the quieter one, or the busy tab stops standing
    // out among the tabs that are merely held. Measured against the acting
    // level rather than a fixed number, so turning the beat up or down keeps
    // the two levels apart by construction.
    const level = (state: string) => {
      const block = css.match(
        new RegExp(`indicator\\[data-state="${state}"\\] \\{([^}]*)\\}`),
      )?.[1] as string;
      return {
        wave: Number.parseFloat(
          /--anbo-automation-wave:\s*([\d.]+)%/.exec(block)?.[1] ?? "",
        ),
        period: Number.parseFloat(
          /--anbo-automation-period:\s*([\d.]+)s/.exec(block)?.[1] ?? "",
        ),
      };
    };
    const acting = level("acting");
    const held = level("held");
    // Faint enough to sit behind the worked tab, not so faint it disappears.
    expect(held.wave).toBeLessThan(acting.wave / 1.8);
    expect(held.wave).toBeGreaterThan(acting.wave / 3);
    expect(held.period).toBeGreaterThan(acting.period * 1.8);
  });
});
