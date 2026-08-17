import { describe, expect, it } from "vitest";
import {
  reserveRuntimeIds,
  runtimeTabIdAllocator,
  takeRuntimeId,
} from "./runtimeId";

describe("runtime tab IDs", () => {
  it("never reuses IDs when the tab store mounts again in one renderer", () => {
    const scope = {};
    const firstMount = runtimeTabIdAllocator(scope);
    const firstIds = [takeRuntimeId(firstMount), takeRuntimeId(firstMount)];

    const secondMount = runtimeTabIdAllocator(scope);
    const secondIds = [takeRuntimeId(secondMount), takeRuntimeId(secondMount)];

    expect(secondMount).toBe(firstMount);
    expect(new Set([...firstIds, ...secondIds]).size).toBe(4);
    expect(secondIds[0]).toBeGreaterThan(firstIds[1]);
  });

  it("advances past IDs retained by a hot refresh", () => {
    const allocator = { current: 1 };

    reserveRuntimeIds(allocator, [4, 19, 7]);

    expect(takeRuntimeId(allocator)).toBe(20);
  });
});
