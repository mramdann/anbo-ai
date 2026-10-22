import { describe, expect, it } from "vitest";
import {
  reserveRuntimeIds,
  runtimeTabIdAllocator,
  takeRuntimeId,
} from "./runtimeId";

function memoryStore() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

describe("runtime tab IDs", () => {
  it("never reuses IDs when the tab store mounts again in one renderer", () => {
    const scope = {};
    const firstMount = runtimeTabIdAllocator(scope, null);
    const firstIds = [takeRuntimeId(firstMount), takeRuntimeId(firstMount)];

    const secondMount = runtimeTabIdAllocator(scope, null);
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

  it("goes on from the last page's IDs after a reload", () => {
    // Round 60: a reloaded page numbered its tabs from 1 again, so the tab,
    // terminal and agent ids that agents still held named other tabs.
    const store = memoryStore();
    const lastPage = runtimeTabIdAllocator({}, store);
    const old = [takeRuntimeId(lastPage), takeRuntimeId(lastPage)];
    reserveRuntimeIds(lastPage, [40]);

    const reloaded = runtimeTabIdAllocator({}, store);

    expect(takeRuntimeId(reloaded)).toBe(41);
    expect(old).toEqual([1, 2]);
  });

  it("starts at 1 without a kept value it can use", () => {
    const store = memoryStore();
    store.setItem("anbo:tabRuntimeIds", "not a number");
    expect(takeRuntimeId(runtimeTabIdAllocator({}, store))).toBe(1);
    expect(takeRuntimeId(runtimeTabIdAllocator({}, null))).toBe(1);
    const refusing = {
      getItem: () => {
        throw new Error("storage is off");
      },
      setItem: () => {
        throw new Error("storage is off");
      },
    };
    const allocator = runtimeTabIdAllocator({}, refusing);
    expect([takeRuntimeId(allocator), takeRuntimeId(allocator)]).toEqual([
      1, 2,
    ]);
  });
});
