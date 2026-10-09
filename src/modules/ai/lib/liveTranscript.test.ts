import { describe, expect, it } from "vitest";
import {
  findSentenceEnd,
  LIVE_WINDOW_SECONDS,
  liveCaption,
  liveIntervalMs,
  liveProvider,
  nextLiveRequestAt,
  planLiveRequest,
  trimSilence,
} from "./liveTranscript";
import { createPcmTake } from "./pcmCapture";

/** `blocks` of 100 ms at 16 kHz, each a steady level. */
function takeOf(levels: number[]) {
  const take = createPcmTake();
  for (const level of levels) take.push(new Float32Array(1_600).fill(level));
  return take;
}

describe("createPcmTake", () => {
  it("slices and measures by seconds in 100 ms blocks", () => {
    const take = takeOf([0, 0.2, 0.5, 0.1]);
    expect(take.seconds()).toBeCloseTo(0.4);
    expect(take.slice(0.1, 0.3).length).toBe(3_200);
    expect(take.slice(0.3)[0]).toBeCloseTo(0.1);
    expect(take.peak(0, 0.2)).toBeCloseTo(0.2);
    expect(take.peak(0.2)).toBeCloseTo(0.5);
    expect(take.peak(0.4)).toBe(0);
  });
});

describe("planLiveRequest", () => {
  it("waits for a second of audio and for new speech", () => {
    expect(planLiveRequest(takeOf(Array(8).fill(0.2)), 0)).toBeNull();
    const take = takeOf(Array(12).fill(0.2));
    expect(planLiveRequest(take, 0)).toEqual({
      from: 0,
      to: take.seconds(),
      cut: false,
    });
    // Less than half a second since the last request.
    expect(planLiveRequest(take, 0.8)).toBeNull();
  });

  it("sends nothing while the user is silent", () => {
    const take = takeOf([...Array(10).fill(0.2), ...Array(10).fill(0.001)]);
    expect(planLiveRequest(take, 1)).toBeNull();
  });

  it("sends only the end of a long take", () => {
    const take = takeOf(Array(300).fill(0.2));
    expect(planLiveRequest(take, 25)).toEqual({
      from: 30 - LIVE_WINDOW_SECONDS,
      to: take.seconds(),
      cut: true,
    });
  });
});

describe("planLiveRequest after a typed sentence", () => {
  it("looks only past the floor", () => {
    // 3 s of speech, typed up to 2 s; then 1.5 s more speech.
    const take = takeOf(Array(35).fill(0.2));
    expect(planLiveRequest(take, 3, 2)).toEqual({
      from: 2,
      to: 3.5,
      cut: false,
    });
    // Under a second past the floor is too little to send.
    expect(planLiveRequest(takeOf(Array(28).fill(0.2)), 0, 2)).toBeNull();
  });
});

describe("trimSilence", () => {
  it("starts a clip 0.3 s before its first sound", () => {
    const take = takeOf([...Array(20).fill(0.001), ...Array(10).fill(0.2)]);
    expect(trimSilence(take, 0, 3)).toBeCloseTo(1.7);
    // Speech from the start, or none at all: nothing to trim.
    expect(trimSilence(take, 2, 3)).toBe(2);
    expect(trimSilence(takeOf(Array(10).fill(0.001)), 0, 1)).toBe(0);
  });

  it("starts a live request after the pause it would open on", () => {
    // Typed up to 1 s; then a second of silence and a second of speech.
    const take = takeOf([
      ...Array(10).fill(0.2),
      ...Array(10).fill(0.001),
      ...Array(10).fill(0.2),
    ]);
    expect(planLiveRequest(take, 1, 1)).toEqual({
      from: 1.7,
      to: 3,
      cut: false,
    });
  });
});

describe("findSentenceEnd", () => {
  const speech = (seconds: number) => Array(seconds * 10).fill(0.2);
  const quiet = (seconds: number) => Array(seconds * 10).fill(0.001);

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

describe("liveCaption", () => {
  it("drops Whisper's sound marks and marks a cut window", () => {
    expect(liveCaption(" [BLANK_AUDIO] ", false)).toBeNull();
    expect(liveCaption("Halo\n semua [Music]", false)).toBe("Halo semua");
    expect(liveCaption("the end of it", true)).toBe("… the end of it");
  });
});

describe("liveProvider", () => {
  it("keeps live text on the local server unless told otherwise", () => {
    expect(liveProvider("local", "groq")).toBe("whispercpp");
    expect(liveProvider("provider", "groq")).toBe("groq");
    expect(liveProvider("provider", "whispercpp")).toBe("whispercpp");
    expect(liveProvider("off", "groq")).toBeNull();
    // Groq's free tier is spread thinner than a local server.
    expect(liveIntervalMs("groq")).toBeGreaterThan(
      liveIntervalMs("whispercpp"),
    );
  });
});

describe("createPcmTake limits", () => {
  it("ignores empty blocks and stops growing a minute past the longest take", () => {
    const take = createPcmTake();
    take.push(new Float32Array(0));
    expect(take.seconds()).toBe(0);
    for (let index = 0; index < 3_700; index += 1) {
      take.push(new Float32Array(16).fill(0.1));
    }
    expect(take.seconds()).toBe(360);
  });
});

describe("nextLiveRequestAt", () => {
  it("keeps live text to half the server's time", () => {
    // A quick local answer: the next request a second after the last went.
    expect(nextLiveRequestAt("whispercpp", 1_000, 1_300)).toBe(2_000);
    // A slow one stretches the cycle to twice its length.
    expect(nextLiveRequestAt("whispercpp", 1_000, 1_900)).toBe(2_800);
    expect(nextLiveRequestAt("groq", 1_000, 1_400)).toBe(4_000);
  });
});
