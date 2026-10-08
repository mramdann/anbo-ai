import {
  holdDockForOpenRead,
  OPEN_READ_LIMIT_MS,
  openReadHoldsDock,
  releaseDockForOpenRead,
  subscribeOpenReads,
} from "@/modules/browser/external/openReads";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("an agent open's read", () => {
  afterEach(() => {
    vi.useRealTimers();
    releaseDockForOpenRead(5);
    releaseDockForOpenRead(6);
  });

  it("holds the dock until the read is done", () => {
    const changed = vi.fn();
    const stop = subscribeOpenReads(changed);
    holdDockForOpenRead(5);
    expect(openReadHoldsDock(5)).toBe(true);
    expect(openReadHoldsDock(6)).toBe(false);
    releaseDockForOpenRead(5);
    expect(openReadHoldsDock(5)).toBe(false);
    expect(changed).toHaveBeenCalledTimes(2);
    // Nothing held, nothing to tell.
    releaseDockForOpenRead(5);
    expect(changed).toHaveBeenCalledTimes(2);
    stop();
  });

  it("gives way after its limit, so a slow read still shows the page", () => {
    vi.useFakeTimers();
    holdDockForOpenRead(6);
    vi.advanceTimersByTime(OPEN_READ_LIMIT_MS - 1);
    expect(openReadHoldsDock(6)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(openReadHoldsDock(6)).toBe(false);
  });
});
