import { describe, expect, it, vi } from "vitest";
import {
  isPlausibleStableViewport,
  schedulePresentationReveal,
  shouldSuspendWindowPresentation,
} from "./windowPresentation";

describe("window presentation policy", () => {
  it("trusts a focused native window when document visibility is stale", () => {
    expect(shouldSuspendWindowPresentation(false, false, false)).toBe(false);
    expect(shouldSuspendWindowPresentation(true, false, false)).toBe(true);
    expect(shouldSuspendWindowPresentation(true, false, true)).toBe(false);
    expect(shouldSuspendWindowPresentation(false, true, true)).toBe(true);
  });

  it("does not replace stable geometry with a thumbnail-sized transition", () => {
    expect(isPlausibleStableViewport(1200, 800, 0, 0)).toBe(true);
    expect(isPlausibleStableViewport(1100, 720, 1200, 800)).toBe(true);
    expect(isPlausibleStableViewport(420, 240, 1200, 800)).toBe(false);
    expect(isPlausibleStableViewport(1200, 0, 1200, 800)).toBe(false);
  });

  it("reveals through the fallback when animation frames stay suspended", () => {
    const frames = new Map<number, () => void>();
    const fallbacks = new Map<number, () => void>();
    const reveal = vi.fn();
    let nextId = 1;
    schedulePresentationReveal(
      {
        requestFrame: (callback) => {
          const id = nextId++;
          frames.set(id, callback);
          return id;
        },
        cancelFrame: (id) => frames.delete(id),
        setFallback: (callback) => {
          const id = nextId++;
          fallbacks.set(id, callback);
          return id;
        },
        clearFallback: (id) => fallbacks.delete(id),
      },
      reveal,
    );

    expect(frames.size).toBe(1);
    expect(fallbacks.size).toBe(1);
    fallbacks.values().next().value?.();
    expect(reveal).toHaveBeenCalledOnce();
    expect(frames.size).toBe(0);
    expect(fallbacks.size).toBe(0);
  });

  it("reveals once after two settled frames and cancels the fallback", () => {
    const frames: Array<() => void> = [];
    const fallback = vi.fn();
    const reveal = vi.fn();
    schedulePresentationReveal(
      {
        requestFrame: (callback) => {
          frames.push(callback);
          return frames.length;
        },
        cancelFrame: vi.fn(),
        setFallback: (callback) => {
          fallback.mockImplementation(callback);
          return 1;
        },
        clearFallback: vi.fn(),
      },
      reveal,
    );

    frames[0]?.();
    expect(reveal).not.toHaveBeenCalled();
    frames[1]?.();
    fallback();
    expect(reveal).toHaveBeenCalledOnce();
  });

  it("does not reveal after a restore is cancelled", () => {
    const frames: Array<() => void> = [];
    let fallback: (() => void) | undefined;
    const reveal = vi.fn();
    const cancel = schedulePresentationReveal(
      {
        requestFrame: (callback) => {
          frames.push(callback);
          return frames.length;
        },
        cancelFrame: vi.fn(),
        setFallback: (callback) => {
          fallback = callback;
          return 1;
        },
        clearFallback: vi.fn(),
      },
      reveal,
    );

    cancel();
    frames[0]?.();
    fallback?.();
    expect(reveal).not.toHaveBeenCalled();
  });
});
