import { describe, expect, it } from "vitest";
import { forwardTo } from "./useStableCallback";

describe("forwardTo", () => {
  it("keeps one function that always runs the latest callback", () => {
    const latest = { current: (a: number, b: number) => a + b };
    const stable = forwardTo(latest);

    expect(stable(2, 3)).toBe(5);
    latest.current = (a, b) => a * b;
    expect(stable(2, 3)).toBe(6);
  });

  it("passes every argument and the return value through", () => {
    const seen: unknown[][] = [];
    const latest = {
      current: (...args: unknown[]) => {
        seen.push(args);
        return "done";
      },
    };
    const stable = forwardTo(latest);

    expect(stable(1, "two", { three: 3 })).toBe("done");
    expect(seen).toEqual([[1, "two", { three: 3 }]]);
  });
});
