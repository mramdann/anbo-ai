import { describe, expect, it } from "vitest";
import { OutputTracker } from "./outputTracker";

describe("OutputTracker", () => {
  it("continues the stream when a long screen scrolls", () => {
    const tracker = new OutputTracker("v1", 10);
    const lines = Array.from({ length: 4_000 }, (_, i) => `line ${i}`);
    const screen = (from: number) => lines.slice(from, from + 2_000).join("\n");
    const first = tracker.read("a", screen(0), undefined, 100);
    // The two screens share about 18 KB, far more than one KMP window.
    const next = tracker.read("a", screen(200), first.cursor, 12_000);
    expect(next.reset).toBe(false);
    expect(next.output.startsWith("\nline 2000")).toBe(true);
  });

  it("starts a new generation when the screen shares nothing", () => {
    const tracker = new OutputTracker("t1", 10);
    const first = tracker.read("a", "before", undefined, 100);
    const next = tracker.read("a", "after", first.cursor, 100);
    expect(next).toMatchObject({ output: "after", reset: true });
    expect(next.cursor).toMatch(/^t1:2:/);
  });

  it("does not take another tracker's cursor", () => {
    const tracker = new OutputTracker("t1", 10);
    tracker.read("a", "output", undefined, 100);
    expect(tracker.read("a", "output", "v1:1:0", 100).reset).toBe(true);
  });
});
