import { describe, expect, it } from "vitest";
import {
  joinVoiceText,
  normalizeVoiceText,
  VOICE_TEXT_LIMIT,
} from "./voiceTarget";

describe("AnboVoice transcript normalization", () => {
  it("turns line breaks and repeated spacing into safe inline text", () => {
    expect(normalizeVoiceText("  buka\n  file\tANBO.md  ")).toBe(
      "buka file ANBO.md",
    );
  });

  it("preserves Unicode text", () => {
    expect(normalizeVoiceText("periksa café dan 漢字")).toBe(
      "periksa café dan 漢字",
    );
  });

  it("bounds the inserted transcript", () => {
    expect(normalizeVoiceText("a".repeat(VOICE_TEXT_LIMIT + 20))).toHaveLength(
      VOICE_TEXT_LIMIT,
    );
  });
});

describe("joinVoiceText", () => {
  it("spaces sentences apart and capitalizes one after a full stop", () => {
    expect(joinVoiceText(null, "first one.")).toBe("first one.");
    expect(joinVoiceText("The first one.", "and the second")).toBe(
      " And the second",
    );
    expect(joinVoiceText("Is it?", "yes")).toBe(" Yes");
    expect(joinVoiceText('He said "stop."', "then left")).toBe(" Then left");
    // Mid-sentence: left as Whisper wrote it.
    expect(joinVoiceText("so we went", "and then")).toBe(" and then");
    expect(joinVoiceText("anything", "")).toBe("");
  });
});
