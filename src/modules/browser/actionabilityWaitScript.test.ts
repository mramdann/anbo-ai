import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

const source = readFileSync(
  new URL(
    "../../../src-tauri/src/modules/browser_automation/actionabilityWait.js",
    import.meta.url,
  ),
  "utf8",
);
const ready = (overrides: Record<string, unknown> = {}) => ({
  ok: true,
  visible: true,
  enabled: true,
  editable: true,
  receives: true,
  x: 20,
  y: 30,
  width: 100,
  height: 40,
  ...overrides,
});

function harness(samples = [ready()], requirement = "pointer", scroll = true) {
  let id = 0;
  let index = 0;
  const frames = new Map<number, () => void>();
  const timers = new Map<number, () => void>();
  const probe = vi.fn(() => samples[Math.min(index++, samples.length - 1)]);
  const setTimeout = vi.fn((callback: () => void, _ms: number) => {
    timers.set(++id, callback);
    return id;
  });
  const promise = vm.runInNewContext(
    `${source}; waitForActionableSample(probe, requirement, scroll)`,
    {
      probe,
      requirement,
      scroll,
      requestAnimationFrame: (callback: () => void) => {
        frames.set(++id, callback);
        return id;
      },
      cancelAnimationFrame: (key: number) => frames.delete(key),
      setTimeout,
      clearTimeout: (key: number) => timers.delete(key),
    },
  ) as Promise<string>;
  const run = (callbacks: Map<number, () => void>) => {
    const pending = [...callbacks.values()];
    callbacks.clear();
    for (const callback of pending) callback();
  };
  return {
    result: promise.then((text) => JSON.parse(text)),
    probe,
    frames,
    timers,
    setTimeout,
    frame: () => run(frames),
    timer: () => run(timers),
  };
}

describe("bounded actionability frame sampling", () => {
  it("requires two frame samples and cancels its fallback on success", async () => {
    const h = harness();
    expect(h.probe).toHaveBeenCalledTimes(1);
    h.frame();
    expect(h.frames.size).toBe(1);
    expect(h.timers.size).toBe(1);
    h.frame();
    expect(await h.result).toMatchObject({ stable: true });
    expect(h.probe.mock.calls).toEqual([[true], [false], [false]]);
    expect(h.frames.size + h.timers.size).toBe(0);
  });

  it("does not accept geometry that changes between render frames", async () => {
    const h = harness([ready(), ready(), ready({ x: 21 })]);
    h.frame();
    h.frame();
    expect(await h.result).toMatchObject({ stable: false, x: 21 });
    expect(h.probe).toHaveBeenCalledTimes(3);
    expect(h.frames.size + h.timers.size).toBe(0);
  });

  it("allows a target that settles before the two frame samples", async () => {
    const h = harness([ready(), ready({ x: 80 }), ready({ x: 80 })]);
    h.frame();
    h.frame();
    expect(await h.result).toMatchObject({ stable: true, x: 80 });
  });

  it("retains the 0.5 pixel geometry tolerance", async () => {
    const h = harness([ready(), ready(), ready({ x: 20.5 })]);
    h.frame();
    h.frame();
    expect(await h.result).toMatchObject({ stable: true });
  });

  it("uses a fresh 100 ms sample when background frames are suspended", async () => {
    const h = harness();
    expect(h.setTimeout.mock.calls[0][1]).toBe(100);
    h.timer();
    expect(await h.result).toMatchObject({ stable: true });
    expect(h.probe.mock.calls).toEqual([[true], [false]]);
    expect(h.frames.size + h.timers.size).toBe(0);
  });

  it("rejects movement during the timer fallback", async () => {
    const h = harness([ready(), ready({ x: 22 })]);
    h.timer();
    expect(await h.result).toMatchObject({ stable: false });
  });

  it("does not hide intermediate movement when the second frame stalls", async () => {
    const h = harness([ready(), ready({ x: 22 }), ready()]);
    h.frame();
    h.timer();
    expect(await h.result).toMatchObject({ stable: false });
    expect(h.frames.size + h.timers.size).toBe(0);
  });

  it.each([
    { visible: false },
    { enabled: false },
    { receives: false },
    { x: Number.NaN },
    { height: Number.POSITIVE_INFINITY },
  ])(
    "rejects an unready initial sample without scheduling work: %j",
    async (bad) => {
      const h = harness([ready(bad)]);
      expect(await h.result).toMatchObject({ stable: false });
      expect(h.probe).toHaveBeenCalledTimes(1);
      expect(h.frames.size + h.timers.size).toBe(0);
    },
  );

  it.each([
    { visible: false },
    { enabled: false },
    { receives: false },
    { ok: false, error: "stale_ref", reason: "destination_changed" },
  ])(
    "revalidates identity and readiness at the final frame: %j",
    async (bad) => {
      const h = harness([ready(), ready(), ready(bad)]);
      h.frame();
      h.frame();
      expect(await h.result).toMatchObject({ ...bad, stable: false });
      expect(h.frames.size + h.timers.size).toBe(0);
    },
  );

  it("preserves focus versus editable action requirements", async () => {
    const focus = harness([ready({ receives: false })], "focus");
    focus.frame();
    focus.frame();
    expect(await focus.result).toMatchObject({ stable: true });
    const editable = harness([ready({ editable: false })], "editable");
    expect(await editable.result).toMatchObject({ stable: false });
    const covered = harness([ready({ receives: false })], "editable");
    expect(await covered.result).toMatchObject({ stable: false });
  });

  it("never scrolls again on a later bounded attempt", async () => {
    const h = harness([ready()], "pointer", false);
    h.frame();
    h.frame();
    await h.result;
    expect(h.probe.mock.calls).toEqual([[false], [false], [false]]);
  });

  it("cancels queued work if a probe throws", async () => {
    const h = harness();
    h.probe.mockImplementationOnce(() => {
      throw Error("document unavailable");
    });
    h.frame();
    await expect(h.result).rejects.toThrow("document unavailable");
    expect(h.frames.size + h.timers.size).toBe(0);
  });

  it("does not probe from a callback already queued when fallback finishes", async () => {
    const h = harness();
    const queuedFrame = [...h.frames.values()][0];
    h.timer();
    await h.result;
    queuedFrame();
    expect(h.probe).toHaveBeenCalledTimes(2);
  });
});
