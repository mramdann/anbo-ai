import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** An audio context that starts, rests and takes any sound's nodes. */
function contextMock(initial: AudioContextState) {
  const param = () => ({
    setValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
  });
  return class AudioContextMock {
    state: AudioContextState = initial;
    currentTime = 1;
    destination = {} as AudioDestinationNode;
    resume = vi.fn(async () => {
      this.state = "running";
    });
    suspend = vi.fn(async () => {
      this.state = "suspended";
    });
    createOscillator = vi.fn(() => ({
      type: "sine",
      frequency: param(),
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    }));
    createGain = vi.fn(() => ({ gain: param(), connect: vi.fn() }));
  };
}

function stubWindow(): EventTarget {
  const eventTarget = new EventTarget();
  vi.stubGlobal("window", {
    addEventListener: eventTarget.addEventListener.bind(eventTarget),
    removeEventListener: eventTarget.removeEventListener.bind(eventTarget),
  });
  return eventTarget;
}

describe("attentionSound", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
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
      suspend = vi.fn(async () => {
        this.state = "suspended";
      });
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
    const { playAttentionSound } = await import("./attentionSoundPlayer");
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
      suspend = vi.fn(async () => {});
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
    const { ATTENTION_SOUNDS } = await import("./attentionSound");
    const { playAttentionSound } = await import("./attentionSoundPlayer");
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
    const eventTarget = stubWindow();

    class AudioContextMock {
      state: AudioContextState = "suspended";
      resume = resume;
    }

    vi.stubGlobal("AudioContext", AudioContextMock);
    const { prepareAttentionSound } = await import("./attentionSound");
    const cleanup = prepareAttentionSound();

    eventTarget.dispatchEvent(new Event("pointerdown"));
    await vi.waitFor(() => expect(resume).toHaveBeenCalledOnce());
    cleanup();
  });

  // A running context renders silence about 100 times a second: it cost the
  // main window about 3% of a core from the first click on (round 109).
  it("rests the context again once the unlock has run it", async () => {
    vi.useFakeTimers();
    const eventTarget = stubWindow();
    vi.stubGlobal("AudioContext", contextMock("suspended"));
    const { audioContext, prepareAttentionSound } = await import(
      "./attentionSound"
    );
    const cleanup = prepareAttentionSound();

    eventTarget.dispatchEvent(new Event("pointerdown"));
    await vi.advanceTimersByTimeAsync(10);
    const audio = audioContext();
    expect(audio?.resume).toHaveBeenCalledOnce();
    expect(audio?.suspend).toHaveBeenCalledOnce();
    expect(audio?.state).toBe("suspended");

    // Unlocked for good: later input does not wake it.
    eventTarget.dispatchEvent(new Event("keydown"));
    await vi.advanceTimersByTimeAsync(10);
    expect(audio?.resume).toHaveBeenCalledOnce();
    cleanup();
  });

  // What the app's own first click meets: a context made inside the gesture
  // is running right away, and no resume is ever asked for.
  it("rests a context that ran from the moment the unlock made it", async () => {
    vi.useFakeTimers();
    const eventTarget = stubWindow();
    vi.stubGlobal("AudioContext", contextMock("running"));
    const { audioContext, prepareAttentionSound } = await import(
      "./attentionSound"
    );
    const cleanup = prepareAttentionSound();

    eventTarget.dispatchEvent(new Event("keydown"));
    await vi.advanceTimersByTimeAsync(10);
    const audio = audioContext();
    expect(audio?.resume).not.toHaveBeenCalled();
    expect(audio?.suspend).toHaveBeenCalledOnce();
    expect(audio?.state).toBe("suspended");

    eventTarget.dispatchEvent(new Event("pointerdown"));
    await vi.advanceTimersByTimeAsync(10);
    expect(audio?.resume).not.toHaveBeenCalled();
    cleanup();
  });

  it("runs the context only while a sound plays", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("AudioContext", contextMock("suspended"));
    const { audioContext } = await import("./attentionSound");
    const { playAttentionSound } = await import("./attentionSoundPlayer");

    // The pop is 0.14 s long; the context rests 0.3 s after it.
    playAttentionSound("pop");
    await vi.advanceTimersByTimeAsync(10);
    const audio = audioContext();
    expect(audio?.resume).toHaveBeenCalledOnce();
    expect(audio?.createOscillator).toHaveBeenCalledOnce();
    expect(audio?.state).toBe("running");

    await vi.advanceTimersByTimeAsync(400);
    expect(audio?.suspend).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(audio?.suspend).toHaveBeenCalledOnce();
    expect(audio?.state).toBe("suspended");

    // The next sound wakes it again, and it rests again.
    playAttentionSound("pop");
    await vi.advanceTimersByTimeAsync(10);
    expect(audio?.resume).toHaveBeenCalledTimes(2);
    expect(audio?.createOscillator).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(500);
    expect(audio?.suspend).toHaveBeenCalledTimes(2);
  });

  it("keeps the context up for a sound that starts while another plays", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("AudioContext", contextMock("suspended"));
    const { audioContext } = await import("./attentionSound");
    const { playAttentionSound } = await import("./attentionSoundPlayer");

    playAttentionSound("pop");
    await vi.advanceTimersByTimeAsync(300);
    // The ding is 1.1 s long: from here the context has to stay up 1.4 s.
    playAttentionSound("ding");
    await vi.advanceTimersByTimeAsync(1_300);
    const audio = audioContext();
    expect(audio?.suspend).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(audio?.suspend).toHaveBeenCalledOnce();

    // A short sound inside a long one does not cut the long one's time.
    playAttentionSound("ding");
    await vi.advanceTimersByTimeAsync(200);
    playAttentionSound("pop");
    await vi.advanceTimersByTimeAsync(1_100);
    expect(audio?.suspend).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(200);
    expect(audio?.suspend).toHaveBeenCalledTimes(2);
  });
});
