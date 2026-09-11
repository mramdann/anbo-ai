import { describe, expect, it, vi } from "vitest";
import {
  admitAgentResume,
  RESUME_ADMISSION_RETRY_MS,
  RESUME_ADMISSION_WINDOW_MS,
} from "./resumeAdmission";

const EXHAUSTED =
  "resource_exhausted: Not enough system memory to start more work (3600 MiB commit available; 4196 MiB required including startup headroom).";

function clock() {
  let at = 1_000;
  return {
    now: () => at,
    sleep: vi.fn(async (ms: number) => {
      at += ms;
    }),
  };
}

describe("admitAgentResume", () => {
  it("admits on the first ask without pausing", async () => {
    const admit = vi.fn(async () => undefined);
    const onPaused = vi.fn();
    const outcome = await admitAgentResume({
      admit,
      abandoned: () => false,
      onPaused,
      ...clock(),
    });
    expect(outcome).toEqual({ kind: "admitted", attempts: 1 });
    expect(onPaused).not.toHaveBeenCalled();
  });

  it("retries a refused resume until the startup reservations expire", async () => {
    const time = clock();
    const refusals = [EXHAUSTED, EXHAUSTED, EXHAUSTED];
    const admit = vi.fn(async () => {
      const refusal = refusals.shift();
      if (refusal) throw new Error(refusal);
    });
    const onPaused = vi.fn();
    const outcome = await admitAgentResume({
      admit,
      abandoned: () => false,
      onPaused,
      ...time,
    });
    expect(outcome).toEqual({ kind: "admitted", attempts: 4 });
    expect(onPaused).toHaveBeenCalledTimes(3);
    expect(onPaused).toHaveBeenNthCalledWith(1, EXHAUSTED, 1);
    expect(time.sleep).toHaveBeenCalledTimes(3);
    for (const [ms] of time.sleep.mock.calls) {
      expect(ms).toBe(RESUME_ADMISSION_RETRY_MS);
    }
  });

  it("gives up with the last refusal once the window has passed", async () => {
    const time = clock();
    const admit = vi.fn(async () => {
      throw EXHAUSTED;
    });
    const outcome = await admitAgentResume({
      admit,
      abandoned: () => false,
      ...time,
    });
    expect(outcome).toEqual({
      kind: "refused",
      attempts: RESUME_ADMISSION_WINDOW_MS / RESUME_ADMISSION_RETRY_MS + 1,
      error: EXHAUSTED,
    });
    expect(time.now() - 1_000).toBe(RESUME_ADMISSION_WINDOW_MS);
  });

  it("never sleeps past the window", async () => {
    const time = clock();
    const outcome = await admitAgentResume({
      admit: async () => {
        throw new Error(EXHAUSTED);
      },
      abandoned: () => false,
      retryMs: 7_000,
      windowMs: 10_000,
      ...time,
    });
    expect(outcome.kind).toBe("refused");
    expect(outcome.attempts).toBe(3);
    expect(time.sleep.mock.calls.map(([ms]) => ms)).toEqual([7_000, 3_000]);
  });

  it("stops asking once the terminal is gone or already busy", async () => {
    const time = clock();
    let busy = false;
    const admit = vi.fn(async () => {
      busy = true;
      throw new Error(EXHAUSTED);
    });
    const outcome = await admitAgentResume({
      admit,
      abandoned: () => busy,
      ...time,
    });
    expect(outcome).toEqual({ kind: "abandoned", attempts: 1 });
    expect(admit).toHaveBeenCalledTimes(1);
  });

  it("does not ask at all for a terminal that is already gone", async () => {
    const admit = vi.fn(async () => undefined);
    const outcome = await admitAgentResume({
      admit,
      abandoned: () => true,
      ...clock(),
    });
    expect(outcome).toEqual({ kind: "abandoned", attempts: 0 });
    expect(admit).not.toHaveBeenCalled();
  });
});
