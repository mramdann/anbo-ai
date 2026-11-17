import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BEAT_ATTRIBUTE, PASS_ATTRIBUTE } from "./beat";

const here = path.dirname(fileURLToPath(import.meta.url));
const css = readFileSync(path.join(here, "../styles/globals.css"), "utf8");

/** An element as far as a beat or a pass reads it: its attributes. */
function mark() {
  const attributes = new Map<string, string>();
  return {
    setAttribute: (name: string, value: string) => {
      attributes.set(name, value);
    },
    removeAttribute: (name: string) => {
      attributes.delete(name);
    },
    beat: () => attributes.get(BEAT_ATTRIBUTE) ?? "full",
    pass: () => attributes.get(PASS_ATTRIBUTE),
    marks: () => [...attributes.keys()],
  };
}

/** The beat keeps its members in the module: every test gets its own. */
async function fresh() {
  vi.resetModules();
  return import("./beat");
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("joinBeat", () => {
  it("runs a timer only while something beats", async () => {
    const { joinBeat } = await fresh();
    expect(vi.getTimerCount()).toBe(0);

    const leaveFirst = joinBeat(mark());
    const leaveSecond = joinBeat(mark());
    expect(vi.getTimerCount()).toBe(1);

    leaveFirst?.();
    expect(vi.getTimerCount()).toBe(1);
    leaveSecond?.();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("holds each of its two levels for a second", async () => {
    const { joinBeat } = await fresh();
    const dot = mark();
    joinBeat(dot);

    expect(dot.beat()).toBe("full");
    vi.advanceTimersByTime(999);
    expect(dot.beat()).toBe("full");
    vi.advanceTimersByTime(1);
    expect(dot.beat()).toBe("low");
    vi.advanceTimersByTime(999);
    expect(dot.beat()).toBe("low");
    vi.advanceTimersByTime(1);
    expect(dot.beat()).toBe("full");
  });

  // One frame a second however many show: a timer each would draw one frame
  // for every indicator.
  it("switches every indicator in the same tick, one that came later too", async () => {
    const { joinBeat } = await fresh();
    const early = mark();
    const late = mark();
    joinBeat(early);
    vi.advanceTimersByTime(400);
    joinBeat(late);

    vi.advanceTimersByTime(599);
    expect([early.beat(), late.beat()]).toEqual(["full", "full"]);
    vi.advanceTimersByTime(1);
    expect([early.beat(), late.beat()]).toEqual(["low", "low"]);
    vi.advanceTimersByTime(1000);
    expect([early.beat(), late.beat()]).toEqual(["full", "full"]);
  });

  it("gives one that joins in the low second the level the others hold", async () => {
    const { joinBeat } = await fresh();
    joinBeat(mark());
    vi.advanceTimersByTime(1300);

    const late = mark();
    joinBeat(late);
    expect(late.beat()).toBe("low");
  });

  it("leaves one that stops beating at full and without a mark while the others beat on", async () => {
    const { joinBeat } = await fresh();
    const stays = mark();
    const goes = mark();
    joinBeat(stays);
    const leave = joinBeat(goes);
    vi.advanceTimersByTime(1000);
    expect(goes.beat()).toBe("low");

    leave?.();
    expect(goes.marks()).toEqual([]);
    expect(stays.beat()).toBe("low");
    vi.advanceTimersByTime(1000);
    expect(stays.beat()).toBe("full");
    expect(goes.marks()).toEqual([]);
  });

  it("starts at full again after everything stopped in the low second", async () => {
    const { joinBeat } = await fresh();
    const leave = joinBeat(mark());
    vi.advanceTimersByTime(1000);
    leave?.();

    const next = mark();
    joinBeat(next);
    expect(next.beat()).toBe("full");
    vi.advanceTimersByTime(999);
    expect(next.beat()).toBe("full");
    vi.advanceTimersByTime(1);
    expect(next.beat()).toBe("low");
  });

  it("is a ref: no element, nothing to do", async () => {
    const { joinBeat } = await fresh();
    expect(joinBeat(null)).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("passesEvery", () => {
  it("starts a pass at once and the next ones on time, each under the other name", async () => {
    const { passesEvery } = await fresh();
    const button = mark();
    passesEvery(4_600)(button);

    expect(button.pass()).toBe("a");
    vi.advanceTimersByTime(4_599);
    expect(button.pass()).toBe("a");
    vi.advanceTimersByTime(1);
    expect(button.pass()).toBe("b");
    vi.advanceTimersByTime(4_600);
    expect(button.pass()).toBe("a");
    expect(vi.getTimerCount()).toBe(1);
  });

  it("gives every element its own passes", async () => {
    const { passesEvery } = await fresh();
    const sheen = passesEvery(4_600);
    const first = mark();
    const second = mark();
    sheen(first);
    vi.advanceTimersByTime(1_000);
    sheen(second);

    vi.advanceTimersByTime(3_600);
    expect([first.pass(), second.pass()]).toEqual(["b", "a"]);
    vi.advanceTimersByTime(1_000);
    expect([first.pass(), second.pass()]).toEqual(["b", "b"]);
  });

  it("leaves no mark and no timer behind", async () => {
    const { passesEvery } = await fresh();
    const button = mark();
    const stop = passesEvery(4_600)(button);
    vi.advanceTimersByTime(5_000);

    stop?.();
    expect(button.marks()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("is a ref: no element, nothing to do", async () => {
    const { passesEvery } = await fresh();
    expect(passesEvery(4_600)(null)).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("the stylesheet's side of a beat and a pass", () => {
  it("dims an indicator the beat holds low and keeps it on its own layer", () => {
    expect(css).toMatch(/\.anbo-beat \{\s*will-change:\s*opacity;\s*\}/);
    expect(css).toMatch(
      new RegExp(
        `\\.anbo-beat\\[${BEAT_ATTRIBUTE}="low"\\] \\{\\s*opacity:\\s*0\\.5;\\s*\\}`,
      ),
    );
  });

  it("runs the sheen one crossing at a time", () => {
    for (const pass of ["a", "b"]) {
      const marked = `\\.anbo-sheen\\[${PASS_ATTRIBUTE}="${pass}"\\]`;
      expect(css).toMatch(
        new RegExp(
          `${marked}::before,\\s*${marked}::after \\{\\s*animation:\\s*anbo-sheen-${pass} 1\\.288s linear;\\s*\\}`,
        ),
      );
    }
    // An animation that never ends never lets the compositor rest.
    expect(css).not.toMatch(/anbo-sheen[^;{}]*infinite/);
  });

  it("names the same crossing twice, so a change of name starts it over", () => {
    const crossing = (name: string) =>
      new RegExp(`@keyframes ${name} \\{([\\s\\S]*?)\\r?\\n\\}`).exec(css)?.[1];
    expect(crossing("anbo-sheen-a")).toContain("translateX(320%)");
    expect(crossing("anbo-sheen-b")).toBe(crossing("anbo-sheen-a"));
  });

  it("keeps the band outside the control between crossings, where one starts", () => {
    expect(css).toMatch(
      /\.anbo-sheen::before,\s*\.anbo-sheen::after \{[^}]*transform:\s*translateX\(-140%\) skewX\(-14deg\);\s*\}/,
    );
    expect(css).toMatch(
      /@keyframes anbo-sheen-a \{\s*from \{\s*transform:\s*translateX\(-140%\) skewX\(-14deg\);/,
    );
  });

  it("holds the sheen still under reduced motion", () => {
    expect(css).toMatch(
      /prefers-reduced-motion: reduce[\s\S]*\.anbo-sheen\[data-pass\]::before,\s*\.anbo-sheen\[data-pass\]::after \{\s*animation:\s*none;\s*\}/,
    );
  });
});
