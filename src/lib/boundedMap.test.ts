import { describe, expect, it } from "vitest";
import { BoundedMap } from "./boundedMap";

describe("BoundedMap", () => {
  it("evicts the least recently used entry", () => {
    const map = new BoundedMap<string, number>(2);
    map.set("a", 1);
    map.set("b", 2);
    expect(map.get("a")).toBe(1);
    map.set("c", 3);
    expect(map.has("a")).toBe(true);
    expect(map.has("b")).toBe(false);
    expect(map.has("c")).toBe(true);
  });
});
