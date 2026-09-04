import { describe, expect, it } from "vitest";
import { isVoiceConfigured, type VoiceSetup } from "./voiceReadiness";

const base: VoiceSetup = {
  provider: "openai",
  hasOpenAiKey: false,
  hasGroqKey: false,
  whisperInstalled: false,
  whisperEndpointOverridden: false,
};

describe("deciding whether to offer voice input", () => {
  it("offers nothing on a fresh install", () => {
    // No key, no runtime: pressing the orb would record and then lose the take.
    expect(isVoiceConfigured(base)).toBe(false);
    expect(isVoiceConfigured({ ...base, provider: "groq" })).toBe(false);
    expect(isVoiceConfigured({ ...base, provider: "whispercpp" })).toBe(false);
  });

  it("wants the key belonging to the selected provider, not any key", () => {
    expect(isVoiceConfigured({ ...base, hasOpenAiKey: true })).toBe(true);
    expect(isVoiceConfigured({ ...base, hasGroqKey: true })).toBe(false);
    expect(
      isVoiceConfigured({ ...base, provider: "groq", hasGroqKey: true }),
    ).toBe(true);
    expect(
      isVoiceConfigured({ ...base, provider: "groq", hasOpenAiKey: true }),
    ).toBe(false);
  });

  it("accepts either a managed runtime or the user's own endpoint", () => {
    const local: VoiceSetup = { ...base, provider: "whispercpp" };
    expect(isVoiceConfigured({ ...local, whisperInstalled: true })).toBe(true);
    expect(
      isVoiceConfigured({ ...local, whisperEndpointOverridden: true }),
    ).toBe(true);
  });

  it("ignores a cloud key when the local provider is selected", () => {
    // Having an OpenAI key says nothing about whether whisper.cpp is ready.
    expect(
      isVoiceConfigured({
        ...base,
        provider: "whispercpp",
        hasOpenAiKey: true,
        hasGroqKey: true,
      }),
    ).toBe(false);
  });
});
