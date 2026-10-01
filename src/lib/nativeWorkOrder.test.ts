import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNativeWorkOrder } from "./nativeWorkOrder";

function track(promise: Promise<void>) {
  const state = { settled: false };
  void promise.then(() => {
    state.settled = true;
  });
  return state;
}

describe("native work order", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits for the restore before letting deferrable work through", async () => {
    const order = createNativeWorkOrder(1_000, 15_000);
    const waiting = track(order.afterPageWork());
    await vi.advanceTimersByTimeAsync(5_000);
    expect(waiting.settled).toBe(false);

    order.markWorkspaceRestored();
    await vi.advanceTimersByTimeAsync(999);
    expect(waiting.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(waiting.settled).toBe(true);
  });

  it("holds deferrable work while a page is going up", async () => {
    const order = createNativeWorkOrder(1_000, 15_000);
    const waiting = track(order.afterPageWork());
    order.markWorkspaceRestored();
    // A pane mounts a few renders after the restore and starts its page.
    await vi.advanceTimersByTimeAsync(300);
    const done = order.beginPageWork();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(waiting.settled).toBe(false);

    done();
    await vi.advanceTimersByTimeAsync(999);
    expect(waiting.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(waiting.settled).toBe(true);
  });

  it("restarts the quiet window when more page work begins", async () => {
    const order = createNativeWorkOrder(1_000, 15_000);
    order.markWorkspaceRestored();
    const waiting = track(order.afterPageWork());
    order.beginPageWork()();
    await vi.advanceTimersByTimeAsync(800);
    order.beginPageWork()();
    await vi.advanceTimersByTimeAsync(800);
    expect(waiting.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(waiting.settled).toBe(true);
  });

  it("gives up waiting on page work that never reports back", async () => {
    const order = createNativeWorkOrder(1_000, 15_000);
    const waiting = track(order.afterPageWork());
    order.markWorkspaceRestored();
    order.beginPageWork();
    await vi.advanceTimersByTimeAsync(14_999);
    expect(waiting.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(waiting.settled).toBe(true);
  });

  it("counts a finished piece of page work once", async () => {
    const order = createNativeWorkOrder(1_000, 15_000);
    order.markWorkspaceRestored();
    const first = order.beginPageWork();
    order.beginPageWork();
    first();
    first();
    const waiting = track(order.afterPageWork());
    await vi.advanceTimersByTimeAsync(5_000);
    expect(waiting.settled).toBe(false);
  });
});
