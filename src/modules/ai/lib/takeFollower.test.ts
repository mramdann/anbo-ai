import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPcmTake } from "./pcmCapture";
import { type FollowTakeOptions, followTake } from "./takeFollower";

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
    live: null,
    sentences: {
      transcribe: async (_wav, seconds) => {
        heard.push(Math.round(seconds * 10) / 10);
        return ` sentence ${heard.length} `;
      },
      type: async (text) => {
        typed.push(text);
        return true;
      },
    },
    onLiveText: () => {},
    log: () => {},
    ...overrides,
  });
  return { follower, state, typed, heard };
}

describe("followTake sentences", () => {
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
      sentences: {
        transcribe: async () => "the first one",
        type: async (text) => {
          typed.push(text);
          return false;
        },
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
      sentences: {
        transcribe: async () => {
          throw new Error("offline");
        },
        type: async () => true,
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
    const typed: string[] = [];
    const { follower, state } = follow(take, {
      sentences: {
        transcribe: () =>
          new Promise<string>((resolve) => {
            answer = resolve;
          }),
        type: async (text) => {
          typed.push(text);
          return true;
        },
      },
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
    const typed: string[] = [];
    const { follower, state } = follow(take, {
      sentences: {
        transcribe: () =>
          new Promise<string>((resolve) => {
            answer = resolve;
          }),
        type: async (text) => {
          typed.push(text);
          return true;
        },
      },
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

describe("followTake live text", () => {
  it("shows the words since the last typed sentence and drops old answers", async () => {
    const { take, speak, pause } = takeWith();
    const shown: (string | null)[] = [];
    const answers: { from: number; resolve: (text: string) => void }[] = [];
    let at = 0;
    const { follower, state } = follow(take, {
      live: {
        provider: "whispercpp",
        transcribe: (_wav, seconds) =>
          new Promise<string>((resolve) => {
            answers.push({ from: take.seconds() - seconds, resolve });
            at += 1;
          }),
        allowed: () => true,
      },
      onLiveText: (text) => shown.push(text),
    });
    speak(1.5);
    await vi.advanceTimersByTimeAsync(300);
    expect(at).toBe(1);
    answers[0].resolve("hello there");
    await vi.advanceTimersByTimeAsync(0);
    expect(shown).toEqual(["hello there"]);
    // A second live request goes out, then the user pauses: the sentence is
    // typed before that answer is back, so the answer is dropped.
    speak(0.5);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(at).toBe(2);
    pause(1);
    await vi.advanceTimersByTimeAsync(300);
    answers[1].resolve("hello there friend");
    await vi.advanceTimersByTimeAsync(0);
    // Typed: the caption went; the old answer did not bring it back.
    expect(shown).toEqual(["hello there", null]);
    state.recording = false;
    await follower.rest();
  });

  it("asks nothing while the quota says no", async () => {
    const { take, speak } = takeWith();
    const transcribe = vi.fn(async () => "words");
    const { follower, state } = follow(take, {
      live: { provider: "groq", transcribe, allowed: () => false },
      sentences: null,
    });
    speak(3);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(transcribe).not.toHaveBeenCalled();
    state.recording = false;
    await follower.rest();
  });
});
