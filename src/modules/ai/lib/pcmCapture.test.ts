import { describe, expect, it } from "vitest";
import { createPcmTake } from "./pcmCapture";

describe("createPcmTake", () => {
  it("slices and measures by seconds in 100 ms blocks", () => {
    const take = createPcmTake();
    for (const level of [0, 0.2, 0.5, 0.1]) {
      take.push(new Float32Array(1_600).fill(level));
    }
    expect(take.seconds()).toBeCloseTo(0.4);
    expect(take.slice(0.1, 0.3).length).toBe(3_200);
    expect(take.slice(0.3)[0]).toBeCloseTo(0.1);
    expect(take.peak(0, 0.2)).toBeCloseTo(0.2);
    expect(take.peak(0.2)).toBeCloseTo(0.5);
    expect(take.peak(0.4)).toBe(0);
  });

  it("ignores empty blocks and stops growing a minute past the longest take", () => {
    const take = createPcmTake();
    take.push(new Float32Array(0));
    expect(take.seconds()).toBe(0);
    for (let index = 0; index < 3_700; index += 1) {
      take.push(new Float32Array(16).fill(0.1));
    }
    expect(take.seconds()).toBe(360);
  });
});
