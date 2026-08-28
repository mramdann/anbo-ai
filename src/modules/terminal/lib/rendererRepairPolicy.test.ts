import { describe, expect, it } from "vitest";
import { shouldRepairWebglFrame } from "./rendererRepairPolicy";

const frame = { width: 800, height: 600, cols: 100, rows: 30 };

describe("shouldRepairWebglFrame", () => {
  it("does not repair an unchanged frame during an ordinary tab switch", () => {
    expect(shouldRepairWebglFrame(frame, { ...frame })).toBe(false);
  });

  it.each([
    [{ ...frame, width: 799 }],
    [{ ...frame, height: 599 }],
    [{ ...frame, cols: 99 }],
    [{ ...frame, rows: 29 }],
  ])("repairs a real geometry change", (previous) => {
    expect(shouldRepairWebglFrame(previous, frame)).toBe(true);
  });

  it("repairs a restored window even when its geometry is unchanged", () => {
    expect(shouldRepairWebglFrame(frame, { ...frame }, true)).toBe(true);
  });
});
