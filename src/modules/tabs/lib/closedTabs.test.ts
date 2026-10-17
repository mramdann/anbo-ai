import { describe, expect, it } from "vitest";
import { noteTabClosed, takeTabClosed } from "./closedTabs";

describe("tabs closed on purpose", () => {
  it("remembers a close until it is taken, once", () => {
    noteTabClosed(5);
    expect(takeTabClosed(5)).toBe(true);
    expect(takeTabClosed(5)).toBe(false);
    expect(takeTabClosed(6)).toBe(false);
  });

  it("keeps only the newest closes", () => {
    for (let id = 1_000; id < 1_300; id++) noteTabClosed(id);
    expect(takeTabClosed(1_000)).toBe(false);
    expect(takeTabClosed(1_043)).toBe(false);
    expect(takeTabClosed(1_044)).toBe(true);
    expect(takeTabClosed(1_299)).toBe(true);
  });
});
