import { describe, expect, it } from "vitest";
import { createGroqQuota } from "./groqQuota";

describe("createGroqQuota", () => {
  it("keeps live requests under the free per-minute limit with room for takes", () => {
    const quota = createGroqQuota();
    const t0 = 1_000_000;
    let live = 0;
    for (let second = 0; second < 60; second += 1) {
      const now = t0 + second * 1000;
      if (quota.liveAllowed(8, now)) {
        quota.note(8, now);
        live += 1;
      }
    }
    expect(live).toBe(12);
    // The minute has passed: live text may go on.
    expect(quota.liveAllowed(8, t0 + 61_000)).toBe(true);
  });

  it("bills at least ten seconds and stops live text near the hourly audio limit", () => {
    const quota = createGroqQuota();
    const t0 = 5_000_000;
    // 600 takes of a few seconds each are billed as 6,000 s.
    for (let index = 0; index < 600; index += 1)
      quota.note(3, t0 + index * 5_000);
    const late = t0 + 600 * 5_000;
    expect(quota.liveAllowed(3, late)).toBe(false);
    // An hour after the first ones, they no longer count.
    expect(quota.liveAllowed(3, t0 + 3_600_000 + 2_000_000)).toBe(true);
  });

  it("waits out a 429 for its retry-after, or a minute without one", () => {
    const quota = createGroqQuota();
    quota.rateLimited(30, 0);
    expect(quota.liveAllowed(5, 29_000)).toBe(false);
    expect(quota.liveAllowed(5, 30_000)).toBe(true);
    quota.rateLimited(null, 100_000);
    expect(quota.liveAllowed(5, 159_000)).toBe(false);
    expect(quota.liveAllowed(5, 160_000)).toBe(true);
  });
});
