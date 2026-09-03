import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("attentionSound", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("waits for a suspended context and plays an audible chime", async () => {
    const start = vi.fn();
    const stop = vi.fn();
    const setFrequency = vi.fn();
    const rampFrequency = vi.fn();
    const setGain = vi.fn();
    const rampGain = vi.fn();
    let finishResume: (() => void) | undefined;

    class AudioContextMock {
      state: AudioContextState = "suspended";
      currentTime = 4;
      destination = {} as AudioDestinationNode;
      resume = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishResume = () => {
              this.state = "running";
              resolve();
            };
          }),
      );
      createOscillator = vi.fn(() => ({
        type: "sine",
        frequency: {
          setValueAtTime: setFrequency,
          exponentialRampToValueAtTime: rampFrequency,
        },
        connect: vi.fn(),
        start,
        stop,
      }));
      createGain = vi.fn(() => ({
        gain: {
          setValueAtTime: setGain,
          exponentialRampToValueAtTime: rampGain,
        },
        connect: vi.fn(),
      }));
    }

    vi.stubGlobal("AudioContext", AudioContextMock);
    const { playAttentionSound } = await import("./attentionSound");
    playAttentionSound();

    expect(start).not.toHaveBeenCalled();
    finishResume?.();
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    expect(rampGain).toHaveBeenCalledWith(0.18, expect.any(Number));
    expect(stop).toHaveBeenCalledOnce();
  });

  it("unlocks Web Audio on the first user interaction", async () => {
    const resume = vi.fn(async () => {});
    const eventTarget = new EventTarget();

    class AudioContextMock {
      state: AudioContextState = "suspended";
      resume = resume;
    }

    vi.stubGlobal("AudioContext", AudioContextMock);
    vi.stubGlobal("window", {
      addEventListener: eventTarget.addEventListener.bind(eventTarget),
      removeEventListener: eventTarget.removeEventListener.bind(eventTarget),
    });
    const { prepareAttentionSound } = await import("./attentionSound");
    const cleanup = prepareAttentionSound();

    eventTarget.dispatchEvent(new Event("pointerdown"));
    await vi.waitFor(() => expect(resume).toHaveBeenCalledOnce());
    cleanup();
  });
});
