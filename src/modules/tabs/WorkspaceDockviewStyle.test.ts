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
    // A few breaths when focus lands, then still: an endless pulse repainted
    // the window at the display rate while the app sat idle.
    expect(css).toContain(
      "animation: anbo-workspace-active-tab-focus-pulse 1.8s ease-in-out 3",
    );
    expect(css).not.toContain(
      "anbo-workspace-active-tab-focus-pulse 1.8s ease-in-out infinite",
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

  it("draws the wave thirty-six times a period, each time as the wave stands at that moment", () => {
    // An animation that never ends keeps the window drawing at the display's
    // rate for as long as an agent holds a tab. Drawn smoothly, the held wave
    // alone took 12% of one core on a machine that draws without a graphics
    // card (round 112). So the keyframes are the wave's own values at 36
    // evenly spaced moments, each held until the next: what is drawn is a
    // frame of the same wave, 36 times a period. The curve below is the
    // design; the stylesheet's numbers have to follow from it.
    const STEPS = 36;
    // CSS cubic-bezier(x1, y1, x2, y2), solved for its input.
    const cubicBezier =
      (x1: number, y1: number, x2: number, y2: number) => (x: number) => {
        const at = (a: number, b: number, t: number) =>
          ((1 - 3 * b + 3 * a) * t + (3 * b - 6 * a)) * t * t + 3 * a * t;
        let low = 0;
        let high = 1;
        let t = x;
        for (let turn = 0; turn < 60; turn += 1) {
          if (at(x1, x2, t) < x) low = t;
          else high = t;
          t = (low + high) / 2;
        }
        return at(y1, y2, t);
      };
    const easeOut = cubicBezier(0, 0, 0.58, 1);
    // Bright by 18%, still half lit at 55%, gone at the end; every stretch
    // eases out, as the smooth wave did.
    const stops = [
      [0, 0],
      [0.18, 0.95],
      [0.55, 0.5],
      [1, 0],
    ];
    const opacityAt = (t: number) => {
      const next = Math.max(
        1,
        stops.findIndex(([at]) => t <= at),
      );
      const [t0, v0] = stops[next - 1];
      const [t1, v1] = stops[next];
      return v0 + (v1 - v0) * easeOut((t - t0) / (t1 - t0));
    };
    const scaleAt = (t: number) => 0.45 + (1.7 - 0.45) * easeOut(t);

    const pulse =
      /@keyframes anbo-browser-automation-pulse \{([\s\S]*?)\n\}/.exec(
        css,
      )?.[1] ?? "";
    const frames = [
      ...pulse.matchAll(
        /([\d.]+)% \{\s*opacity: ([\d.]+);\s*transform: scale\(([\d.]+)\);\s*\}/g,
      ),
    ].map((match) => match.slice(1).map(Number));
    expect(frames).toHaveLength(STEPS + 1);
    frames.forEach(([at, opacity, scale], step) => {
      const t = step / STEPS;
      expect(at).toBeCloseTo(t * 100, 3);
      expect(opacity).toBeCloseTo(opacityAt(t), 3);
      expect(scale).toBeCloseTo(scaleAt(t), 3);
    });
    // Each keyframe holds until the next one: no frame in between.
    expect(css).toMatch(
      /animation: anbo-browser-automation-pulse var\(--anbo-automation-period, 1\.8s\)\s+step-end infinite;/,
    );
    // The second ring starts half a period in. Only an even count puts its
    // steps on the first ring's, so that both change in one frame.
    expect(STEPS % 2).toBe(0);
    // A step is too small to see: under half a pixel at the ring's outer edge
    // (84% of the 8 px the mark's box leaves it).
    const widest = Math.max(
      ...frames.slice(1).map(([, , scale], step) => scale - frames[step][2]),
    );
    expect(widest * 8 * 0.84).toBeLessThan(0.5);
  });

  it("rests the wave of a parked session but keeps held and acting tabs beating", () => {
    expect(css).toMatch(
      /indicator\[data-state="idle"\]::before,\s*\.anbo-browser-automation-indicator\[data-state="idle"\]::after \{\s*animation: none;/,
    );
    expect(css).not.toMatch(
      /indicator\[data-state="(?:held|acting)"\]::(?:before|after)/,
    );
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
