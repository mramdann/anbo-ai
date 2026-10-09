import { describe, expect, it } from "vitest";
import {
  LIVE_WINDOW_SECONDS,
  liveCaption,
  nextLiveRequestAt,
  liveIntervalMs,
  liveProvider,
  planLiveRequest,
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
    expect(planLiveRequest(take, 0)).toEqual({ from: 0, to: take.seconds() });
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
    });
  });
});

describe("liveCaption", () => {
  it("drops Whisper's sound marks and marks a cut window", () => {
    expect(liveCaption(" [BLANK_AUDIO] ", 0)).toBeNull();
    expect(liveCaption("Halo\n semua [Music]", 0)).toBe("Halo semua");
    expect(liveCaption("the end of it", 6)).toBe("… the end of it");
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
