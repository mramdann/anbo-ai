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

  it("plays every sound in the menu and stays silent for none", async () => {
    let oscillators = 0;
    let stops = 0;
    const ramps: number[] = [];
    const param = () => ({
      setValueAtTime: vi.fn(),
      exponentialRampToValueAtTime: vi.fn((value: number) => {
        ramps.push(value);
      }),
    });

    class AudioContextMock {
      state: AudioContextState = "running";
      currentTime = 2;
      destination = {} as AudioDestinationNode;
      resume = vi.fn(async () => {});
      createOscillator = vi.fn(() => {
        oscillators += 1;
        return {
          type: "sine",
          frequency: param(),
          connect: vi.fn(),
          start: vi.fn(),
          stop: vi.fn(() => {
            stops += 1;
          }),
        };
      });
      createGain = vi.fn(() => ({ gain: param(), connect: vi.fn() }));
    }

    vi.stubGlobal("AudioContext", AudioContextMock);
    const { ATTENTION_SOUNDS, playAttentionSound } = await import(
      "./attentionSound"
    );
    for (const sound of ATTENTION_SOUNDS) {
      oscillators = 0;
      stops = 0;
      ramps.length = 0;
      playAttentionSound(sound.id);
      await Promise.resolve();
      if (sound.id === "none") {
        expect(oscillators).toBe(0);
        continue;
      }
      expect(oscillators, sound.id).toBeGreaterThan(0);
      expect(stops, sound.id).toBe(oscillators);
      // An exponential ramp to zero or below throws in Web Audio.
      expect(
        ramps.every((value) => value > 0),
        sound.id,
      ).toBe(true);
    }
  });

  it("knows the sounds it offers", async () => {
    const { isAttentionSoundId } = await import("./attentionSound");
    expect(isAttentionSoundId("chime")).toBe(true);
    expect(isAttentionSoundId("none")).toBe(true);
    expect(isAttentionSoundId("siren")).toBe(false);
    expect(isAttentionSoundId(undefined)).toBe(false);
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
