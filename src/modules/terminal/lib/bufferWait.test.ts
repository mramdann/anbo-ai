import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BufferWaitList } from "./bufferWait";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("leaves waiting for a live buffer", () => {
  it("reports a leaf once when no buffer frees in time", () => {
    const list = new BufferWaitList(400);
    const report = vi.fn();
    list.wait(7, report);
    list.wait(7, report);
    vi.advanceTimersByTime(399);
    expect(report).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(report).toHaveBeenCalledOnce();
    // Still waiting after the report: a buffer that frees later goes to it.
    expect(list.size).toBe(1);
    expect(list.stop(7)).toBe(true);
  });

  // A switch at a full pool: the tab left behind gives its buffer back a few
  // milliseconds later, and the new tab takes it without any report.
  it("reports nothing when the leaf got a buffer first", () => {
    const list = new BufferWaitList(400);
    const report = vi.fn();
    list.wait(7, report);
    vi.advanceTimersByTime(30);
    expect(list.stop(7)).toBe(false);
    vi.advanceTimersByTime(1_000);
    expect(report).not.toHaveBeenCalled();
    expect(list.size).toBe(0);
  });

  it("retries every waiting leaf once, after the call that freed a buffer", () => {
    const list = new BufferWaitList(400);
    list.wait(7, () => {});
    list.wait(8, () => {});
    const attempt = vi.fn();
    list.retrySoon(attempt);
    list.retrySoon(attempt);
    expect(attempt).not.toHaveBeenCalled();
    vi.advanceTimersByTime(0);
    expect(attempt.mock.calls.map(([leafId]) => leafId)).toEqual([7, 8]);
  });

  it("does nothing when no leaf waits", () => {
    const list = new BufferWaitList(400);
    const attempt = vi.fn();
    list.retrySoon(attempt);
    vi.runAllTimers();
    expect(attempt).not.toHaveBeenCalled();
    expect(list.stop(3)).toBe(false);
  });
});
