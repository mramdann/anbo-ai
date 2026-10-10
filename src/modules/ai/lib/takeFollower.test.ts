import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPcmTake } from "./pcmCapture";
import {
  type FollowTakeOptions,
  findSentenceEnd,
  followTake,
  trimSilence,
} from "./takeFollower";

/** `levels` of 100 ms blocks at 16 kHz, each a steady level. */
function takeOf(levels: number[]) {
  const take = createPcmTake();
  for (const level of levels) take.push(new Float32Array(1_600).fill(level));
  return take;
}

const speech = (seconds: number) => Array(seconds * 10).fill(0.2);
const quiet = (seconds: number) => Array(seconds * 10).fill(0.001);

describe("trimSilence", () => {
  it("starts a clip 0.3 s before its first sound", () => {
    const take = takeOf([...quiet(2), ...speech(1)]);
    expect(trimSilence(take, 0, 3)).toBeCloseTo(1.7);
    // Speech from the start, or none at all: nothing to trim.
    expect(trimSilence(take, 2, 3)).toBe(2);
    expect(trimSilence(takeOf(quiet(1)), 0, 1)).toBe(0);
  });
});

describe("findSentenceEnd", () => {
  it("ends a sentence 0.3 s into a pause of 0.8 s", () => {
    const take = takeOf([...speech(2), ...quiet(0.8)]);
    expect(findSentenceEnd(take, 0)).toBeCloseTo(2.3);
  });

  it("waits while the user speaks, pauses too briefly, or said nothing", () => {
    expect(findSentenceEnd(takeOf(speech(3)), 0)).toBeNull();
    expect(
      findSentenceEnd(takeOf([...speech(2), ...quiet(0.5)]), 0),
    ).toBeNull();
    expect(findSentenceEnd(takeOf(quiet(3)), 0)).toBeNull();
    // A cough before the pause is not a sentence.
    expect(
      findSentenceEnd(takeOf([...speech(0.5), ...quiet(0.8)]), 0),
    ).toBeNull();
  });

  it("starts looking where the last sentence ended", () => {
    const take = takeOf([
      ...speech(2),
      ...quiet(1),
      ...speech(2),
      ...quiet(0.8),
    ]);
    expect(findSentenceEnd(take, 2.3)).toBeCloseTo(5.3);
    // Only silence since the last sentence.
    expect(
      findSentenceEnd(takeOf([...speech(2), ...quiet(3)]), 2.3),
    ).toBeNull();
  });
});

describe("followTake", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function takeWith() {
    const take = createPcmTake();
    const add = (seconds: number, level: number) => {
      for (let index = 0; index < Math.round(seconds * 10); index += 1) {
        take.push(new Float32Array(1_600).fill(level));
      }
    };
    return {
      take,
      speak: (seconds: number) => add(seconds, 0.2),
      pause: (seconds: number) => add(seconds, 0.001),
    };
  }

  function follow(
    take: FollowTakeOptions["take"],
    overrides: Partial<FollowTakeOptions> = {},
  ) {
    const state = { recording: true, wanted: true };
    const typed: string[] = [];
    const heard: number[] = [];
    const follower = followTake({
      take,
      recording: () => state.recording,
      wanted: () => state.wanted,
      transcribe: async (_wav, seconds) => {
        heard.push(Math.round(seconds * 10) / 10);
        return ` sentence ${heard.length} `;
      },
      type: async (text) => {
        typed.push(text);
        return true;
      },
      log: () => {},
      ...overrides,
    });
    return { follower, state, typed, heard };
  }

  it("types each sentence after a pause, in order, and leaves the rest", async () => {
    const { take, speak, pause } = takeWith();
    const { follower, state, typed, heard } = follow(take);
    speak(2);
    pause(1);
    await vi.advanceTimersByTimeAsync(300);
    expect(typed).toEqual(["sentence 1"]);
    speak(3);
    pause(0.9);
    await vi.advanceTimersByTimeAsync(300);
    expect(typed).toEqual(["sentence 1", "sentence 2"]);
    // A pause is seen once 0.8 s of it is there and the sentence keeps 0.3 s
    // of it: here the first second of pause arrived at once, so the first
    // sentence ran to 2.5 s. The second ran to 6.4 s and starts 0.3 s before
    // its first sound, at 2.7 s, not on the pause before it.
    expect(heard).toEqual([2.5, 3.7]);
    speak(1);
    state.recording = false;
    const rest = await follower.rest();
    expect(rest.from).toBeCloseTo(6.4);
    expect(rest.untyped).toEqual([]);
  });

  it("stops typing after a sentence it could not type, and hands it back", async () => {
    const { take, speak, pause } = takeWith();
    const typed: string[] = [];
    const { follower, state } = follow(take, {
      transcribe: async () => "the first one",
      type: async (text) => {
        typed.push(text);
        return false;
      },
    });
    speak(2);
    pause(1);
    await vi.advanceTimersByTimeAsync(300);
    speak(2);
    pause(1);
    await vi.advanceTimersByTimeAsync(600);
    // One attempt only: typing into a changed target is not tried again.
    expect(typed).toEqual(["the first one"]);
    state.recording = false;
    const rest = await follower.rest();
    expect(rest.untyped).toEqual(["the first one"]);
    expect(rest.from).toBeCloseTo(2.5);
  });

  it("keeps the audio of a sentence it could not transcribe for the end", async () => {
    const { take, speak, pause } = takeWith();
    const { follower, state, typed } = follow(take, {
      transcribe: async () => {
        throw new Error("offline");
      },
    });
    speak(2);
    pause(1);
    await vi.advanceTimersByTimeAsync(300);
    state.recording = false;
    const rest = await follower.rest();
    expect(typed).toEqual([]);
    expect(rest).toEqual({ from: 0, untyped: [] });
  });

  it("types nothing once the take is cancelled", async () => {
    const { take, speak, pause } = takeWith();
    let answer: ((text: string) => void) | undefined;
    const { follower, state, typed } = follow(take, {
      transcribe: () =>
        new Promise<string>((resolve) => {
          answer = resolve;
        }),
    });
    speak(2);
    pause(1);
    await vi.advanceTimersByTimeAsync(300);
    state.wanted = false;
    state.recording = false;
    answer?.("too late");
    await follower.rest();
    expect(typed).toEqual([]);
  });

  it("finishes the sentence on its way before the rest is handed over", async () => {
    const { take, speak, pause } = takeWith();
    let answer: ((text: string) => void) | undefined;
    const { follower, state, typed } = follow(take, {
      transcribe: () =>
        new Promise<string>((resolve) => {
          answer = resolve;
        }),
    });
    speak(2);
    pause(1);
    await vi.advanceTimersByTimeAsync(300);
    state.recording = false;
    const rest = follower.rest();
    answer?.("last words");
    expect((await rest).from).toBeCloseTo(2.5);
    expect(typed).toEqual(["last words"]);
  });
});
