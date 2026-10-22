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

describe("OutputTracker continuation", () => {
  const prompt = "PS D:\\work> ";
  const rows = (prefix: string, count: number) =>
    Array.from({ length: count }, (_, i) => `${prefix} ${i}`).join("\n");

  it("does not take a shared prompt line for a scrolled screen", () => {
    // Measured (round 60): the old view ended at an idle prompt and a new
    // window started with an older prompt line; the read after the agent's
    // cursor replayed that window as new output, reset false.
    const tracker = new OutputTracker("t1", 10);
    const before = `${rows("job", 40)}\nSELESAI\n${prompt}`;
    const first = tracker.read("a", before, undefined, 100);
    const after = `${prompt}Get-Content app/index.html\n${rows("<thead>", 60)}\nSELESAI\n${prompt}`;
    const next = tracker.read("a", after, first.cursor, 12_000);
    expect(next.reset).toBe(true);
  });

  it("goes on after a last line rewritten in place", () => {
    const tracker = new OutputTracker("t1", 10);
    const first = tracker.read("a", "a\nb\nc\nprogress 50%", undefined, 100);
    const next = tracker.read(
      "a",
      "a\nb\nc\nprogress 100%\ndone",
      first.cursor,
      100,
    );
    expect(next).toMatchObject({
      output: "\nprogress 100%\ndone",
      reset: false,
    });
  });

  it("reads only the new run of a repeated command on a scrolled screen", () => {
    const tracker = new OutputTracker("t1", 10);
    const run = (n: number) =>
      `${prompt}Get-Date\n\nThursday, October 22, 2026 21:${String(n).padStart(2, "0")}:00\n\n`;
    const history = Array.from({ length: 30 }, (_, n) => run(n)).join("");
    const first = tracker.read("a", `${history}${prompt}`, undefined, 100);
    const lines = `${history}${run(30)}${prompt}`.split("\n");
    const scrolled = lines.slice(5).join("\n");
    const next = tracker.read("a", scrolled, first.cursor, 12_000);
    expect(next).toMatchObject({
      output: `Get-Date\n\nThursday, October 22, 2026 21:30:00\n\n${prompt}`,
      reset: false,
    });
  });
});
