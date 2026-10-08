import { describe, expect, it, vi } from "vitest";
import { createMaximizedCheck } from "./windowShape";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("window shape", () => {
  it("asks once per frame however many resize events arrive", async () => {
    const frames: Array<() => void> = [];
    const query = vi.fn(async () => true);
    const publish = vi.fn();
    const check = createMaximizedCheck(query, publish, (callback) => {
      frames.push(callback);
    });
    check.soon();
    check.soon();
    check.soon();
    expect(frames).toHaveLength(1);
    frames.shift()?.();
    await settle();
    expect(query).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(true);
    check.soon();
    expect(frames).toHaveLength(1);
  });

  it("keeps the newest answer when an older one arrives late", async () => {
    const answers: Array<(value: boolean) => void> = [];
    const publish = vi.fn();
    const check = createMaximizedCheck(
      () => new Promise<boolean>((resolve) => answers.push(resolve)),
      publish,
      (callback) => callback(),
    );
    check.now();
    check.soon();
    answers[1](false);
    answers[0](true);
    await settle();
    expect(publish.mock.calls).toEqual([[false]]);
  });

  it("ignores a failed question", async () => {
    const publish = vi.fn();
    const check = createMaximizedCheck(
      () => Promise.reject(new Error("window closed")),
      publish,
      (callback) => callback(),
    );
    check.now();
    await settle();
    expect(publish).not.toHaveBeenCalled();
  });
});
