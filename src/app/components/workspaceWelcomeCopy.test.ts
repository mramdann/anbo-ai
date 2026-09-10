import { describe, expect, it } from "vitest";
import {
  benchCaption,
  daySeed,
  greetingFor,
  TAGLINE_COUNT,
  taglineFor,
} from "./workspaceWelcomeCopy";

describe("benchCaption", () => {
  it("names a few and counts the rest", () => {
    expect(benchCaption([])).toBe("");
    expect(benchCaption(["Claude"])).toBe("Claude is on the bench.");
    expect(benchCaption(["Claude", "Codex"])).toBe(
      "Claude and Codex are on the bench.",
    );
    expect(benchCaption(["Claude", "Codex", "Pi"])).toBe(
      "Claude, Codex and Pi are on the bench.",
    );
    expect(benchCaption(["Claude", "Codex", "Pi", "Grok", "OpenCode"])).toBe(
      "Claude, Codex, Pi and 2 more are on the bench.",
    );
  });
});

describe("greetingFor", () => {
  it("follows the clock through the day", () => {
    expect(greetingFor(5)).toBe("Good morning");
    expect(greetingFor(11)).toBe("Good morning");
    expect(greetingFor(12)).toBe("Good afternoon");
    expect(greetingFor(16)).toBe("Good afternoon");
    expect(greetingFor(17)).toBe("Good evening");
    expect(greetingFor(21)).toBe("Good evening");
  });

  it("treats the small hours as late, not early", () => {
    expect(greetingFor(22)).toBe("Working late");
    expect(greetingFor(0)).toBe("Working late");
    expect(greetingFor(4)).toBe("Working late");
  });
});

describe("taglineFor", () => {
  it("does not change while you look at it", () => {
    const seed = daySeed("anbo-ai", new Date(2026, 8, 6));
    expect(taglineFor(seed, 7)).toBe(taglineFor(seed, 7));
  });

  it("varies across workspaces and days rather than always saying the same thing", () => {
    const seen = new Set<string>();
    for (let day = 1; day <= 31; day++) {
      seen.add(taglineFor(daySeed("anbo-ai", new Date(2026, 8, day)), 7));
    }
    expect(seen.size).toBeGreaterThan(1);
    expect(seen.size).toBeLessThanOrEqual(TAGLINE_COUNT);
  });

  it("counts its agents in the singular when there is one", () => {
    // Every line in the pool must read correctly for one agent, whichever
    // seed lands on it.
    for (let day = 1; day <= 31; day++) {
      const line = taglineFor(daySeed("solo", new Date(2026, 8, day)), 1);
      expect(line).not.toMatch(/\b1 agents\b/);
    }
  });

  it("says nothing about picking one when there is nothing to pick", () => {
    // Reachable on a machine with no agent CLI installed. "0 agents on the
    // bench. Pick one" would invite a click that cannot land.
    for (let day = 1; day <= 62; day++) {
      const line = taglineFor(daySeed("bare", new Date(2026, 8, day)), 0);
      expect(line).not.toMatch(/0 agents/);
      expect(line).not.toMatch(/Pick one/);
    }
  });

  it("carries the real count when there are several", () => {
    // Find a seed that lands on the counting line, then check the number.
    for (let day = 1; day <= 62; day++) {
      const line = taglineFor(daySeed("crew", new Date(2026, 8, day)), 9);
      if (line.includes("on the bench")) {
        expect(line).toContain("9 agents");
        return;
      }
    }
    throw new Error("no seed reached the counting line in 62 days");
  });
});
