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

  it("flags left-out history only on a read that did not start at a cursor", () => {
    // Round 64 (R64-12): every cursor read of a terminal with earlier output
    // said historyTruncated, and agents took complete reads for cut ones.
    const tracker = new OutputTracker("t1", 10);
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`);
    const tail = tracker.read("a", lines.join("\n"), undefined, 100);
    expect(tail.historyTruncated).toBe(true);
    const more = `${lines.join("\n")}\nline 200\nline 201`;
    const next = tracker.read("a", more, tail.cursor, 100);
    expect(next).toMatchObject({
      output: "\nline 200\nline 201",
      reset: false,
      historyTruncated: false,
    });
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

  it("reads a window a new width moved back as a repaint, not as new output", () => {
    // Round 66 (R66-6): the same job ran twice in one terminal. Widened, the
    // last rows reached back to the first run's end, identical to the second
    // run's, and the history after it came back as new output, reset false.
    const tracker = new OutputTracker("t1", 10);
    const job = `node job.js\n${rows("langkah", 90)}\nSELESAI\n${prompt}`;
    const afterFirst = `npm install dayjs\nup to date in 735ms\n${prompt}`;
    const narrow = `${afterFirst}\nSet-Content job.js\n${job}`;
    const cursor = tracker.checkpoint("a", narrow, 80);
    const wide = `langkah 88\nlangkah 89\nSELESAI\n${prompt}\n${narrow}`;
    const next = tracker.read("a", wide, cursor, 12_000, 120);
    expect(next.reset).toBe(true);
    expect(next.cursor).toMatch(/^t1:2:/);
    expect(next.output.endsWith(job)).toBe(true);
  });

  it("goes on at the same width with lines that repeat", () => {
    const tracker = new OutputTracker("t1", 10);
    const before = `${rows("build", 30)}\nSELESAI\n${prompt}`;
    const cursor = tracker.checkpoint("a", before, 80);
    const after = `${before.split("\n").slice(10).join("\n")}npm test\nSELESAI\n${prompt}`;
    const next = tracker.read("a", after, cursor, 12_000, 80);
    expect(next).toMatchObject({
      output: `npm test\nSELESAI\n${prompt}`,
      reset: false,
    });
  });
});
