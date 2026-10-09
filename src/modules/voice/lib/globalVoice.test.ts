import { describe, expect, it } from "vitest";
import { isPushToTalkKey, PUSH_TO_TALK_KEYS } from "./globalVoice";

describe("isPushToTalkKey", () => {
  it("accepts the chords the shell knows and nothing else", () => {
    // The names are the Rust `PttKey` serde names; a stored value the shell
    // cannot read would turn hold to talk off without saying so.
    expect([...PUSH_TO_TALK_KEYS]).toEqual([
      "win",
      "ctrl_win",
      "right_alt",
      "off",
    ]);
    for (const key of PUSH_TO_TALK_KEYS)
      expect(isPushToTalkKey(key)).toBe(true);
    for (const value of ["Win", "ctrl+win", "", null, 3, undefined]) {
      expect(isPushToTalkKey(value)).toBe(false);
    }
  });
});
