import { describe, expect, it, vi } from "vitest";
import { LatestResizeQueue, type TerminalSize } from "./latestResizeQueue";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("LatestResizeQueue", () => {
  it("serializes resize work and keeps only the newest pending size", async () => {
    const first = deferred();
    const applied: TerminalSize[] = [];
    let active = 0;
    let peak = 0;
    const apply = vi.fn(async (size: TerminalSize) => {
      active += 1;
      peak = Math.max(peak, active);
      applied.push(size);
      if (applied.length === 1) await first.promise;
      active -= 1;
    });
    const queue = new LatestResizeQueue(apply);

    const initial = queue.request({ cols: 80, rows: 24 });
    const middle = queue.request({ cols: 60, rows: 20 });
    const latest = queue.request({ cols: 72, rows: 22 });

    expect(applied).toEqual([{ cols: 80, rows: 24 }]);
    first.resolve();
    await Promise.all([initial, middle, latest]);

    expect(applied).toEqual([
      { cols: 80, rows: 24 },
      { cols: 72, rows: 22 },
    ]);
    expect(peak).toBe(1);
  });

  it("drops pending work after disposal", async () => {
    const first = deferred();
    const applied: TerminalSize[] = [];
    const queue = new LatestResizeQueue(async (size) => {
      applied.push(size);
      await first.promise;
    });

    const running = queue.request({ cols: 80, rows: 24 });
    queue.request({ cols: 100, rows: 30 });
    queue.dispose();
    first.resolve();
    await running;

    expect(applied).toEqual([{ cols: 80, rows: 24 }]);
  });
});
