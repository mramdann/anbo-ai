import { describe, expect, it } from "vitest";
import { normalizeVoiceText, VOICE_TEXT_LIMIT } from "./voiceTarget";

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
