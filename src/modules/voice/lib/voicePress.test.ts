import { describe, expect, it } from "vitest";
import { resolveVoicePress, type VoicePressState } from "./voicePress";

const idle: VoicePressState = {
  recording: false,
  requesting: false,
  transcribing: false,
  inserting: false,
  starting: false,
};

describe("resolveVoicePress", () => {
  it("starts from a fully idle orb", () => {
    expect(resolveVoicePress(idle)).toBe("start");
  });

  it("stops an active recording", () => {
    expect(resolveVoicePress({ ...idle, recording: true })).toBe("stop");
  });

  it("aborts a start that is still acquiring its target", () => {
    expect(resolveVoicePress({ ...idle, starting: true })).toBe("abortStart");
  });

  it("cancels while requesting, transcribing or inserting", () => {
    expect(resolveVoicePress({ ...idle, requesting: true })).toBe("cancel");
    expect(resolveVoicePress({ ...idle, transcribing: true })).toBe("cancel");
    expect(resolveVoicePress({ ...idle, inserting: true })).toBe("cancel");
  });

  it("never ignores a press, whatever the combination", () => {
    const flags = [
      "recording",
      "requesting",
      "transcribing",
      "inserting",
      "starting",
    ] as const;
    for (let mask = 0; mask < 1 << flags.length; mask += 1) {
      const state = { ...idle };
      flags.forEach((flag, index) => {
        state[flag] = (mask & (1 << index)) !== 0;
      });
      expect(resolveVoicePress(state)).toBeTruthy();
    }
  });

  it("keeps stop ahead of a stale starting flag", () => {
    expect(resolveVoicePress({ ...idle, recording: true, starting: true })).toBe(
      "stop",
    );
  });
});
