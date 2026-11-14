import { describe, expect, it, vi } from "vitest";
import { createProcessMark, MARKS } from "./mark.js";

describe("the mark the native host asks for", () => {
  it("is offered where the memory goes back the moment the hold ends", async () => {
    expect(MARKS).toBe(true);
    // A browser before ArrayBuffer.transfer: the memory would wait for a
    // collection, so the host is told not to ask, and a hold is refused.
    const transfer = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "transfer");
    delete ArrayBuffer.prototype.transfer;
    vi.resetModules();
    try {
      const old = await import("./mark.js");
      expect(old.MARKS).toBe(false);
      const mark = old.createProcessMark();
      expect(mark.set(16)).toBe(false);
      expect(mark.held()).toBe(0);
    } finally {
      Object.defineProperty(ArrayBuffer.prototype, "transfer", transfer);
      vi.resetModules();
    }
    expect(typeof ArrayBuffer.prototype.transfer).toBe("function");
  });

  it("holds the megabytes asked for until it is told to let go", () => {
    const mark = createProcessMark();
    expect(mark.held()).toBe(0);
    expect(mark.set(2)).toBe(true);
    expect(mark.held()).toBe(2);
    mark.clear();
    expect(mark.held()).toBe(0);
    // Letting go twice, or with nothing held, is no error.
    mark.clear();
  });

  it("gives the memory back at once", () => {
    const made = [];
    const real = globalThis.ArrayBuffer;
    const transfer = vi.fn();
    globalThis.ArrayBuffer = class {
      constructor(bytes) {
        this.byteLength = bytes;
        this.transfer = transfer;
        made.push(this);
      }
    };
    try {
      const mark = createProcessMark();
      expect(mark.set(32)).toBe(true);
      expect(made.map((buffer) => buffer.byteLength)).toEqual([32 * 1024 * 1024]);
      mark.clear();
      expect(transfer).toHaveBeenCalledWith(0);
      // A second hold replaces the first, which goes back too.
      mark.set(8);
      mark.set(16);
      expect(transfer).toHaveBeenCalledTimes(2);
      expect(mark.held()).toBe(16);
    } finally {
      globalThis.ArrayBuffer = real;
    }
  });

  it("refuses an amount out of range, and a hold the memory is not there for", () => {
    const mark = createProcessMark();
    for (const odd of [0, -1, 65, 1.5, "32", null, undefined, Number.NaN]) {
      expect(mark.set(odd), String(odd)).toBe(false);
      expect(mark.held()).toBe(0);
    }
    const real = globalThis.ArrayBuffer;
    globalThis.ArrayBuffer = class {
      constructor() {
        throw new RangeError("Array buffer allocation failed");
      }
    };
    try {
      expect(mark.set(32)).toBe(false);
      expect(mark.held()).toBe(0);
    } finally {
      globalThis.ArrayBuffer = real;
    }
  });

  it("lets go by itself when the host never says so", () => {
    let fire = null;
    const cleared = vi.fn();
    const mark = createProcessMark((run, ms) => {
      expect(ms).toBe(10_000);
      fire = run;
      return 7;
    }, cleared);
    mark.set(1);
    fire();
    expect(mark.held()).toBe(0);
    // Told to let go in time, the timer goes with it.
    mark.set(1);
    mark.clear();
    expect(cleared).toHaveBeenLastCalledWith(7);
  });
});
