import type { SttProvider } from "@/modules/ai/config";

/**
 * Whether voice input has been set up enough to be worth offering.
 *
 * The orb is a promise that pressing it will produce text. Before an API key
 * is entered, or before the local runtime is installed, that promise cannot be
 * kept: the recording happens, the request fails, and the take is lost. Showing
 * nothing until voice can actually work is the honest default.
 */
export type VoiceSetup = {
  provider: SttProvider;
  hasOpenAiKey: boolean;
  hasGroqKey: boolean;
  /** A managed whisper.cpp runtime with at least one model on disk. */
  whisperInstalled: boolean;
  /** True once the user pointed whisper.cpp at an endpoint of their own. */
  whisperEndpointOverridden: boolean;
};

export function isVoiceConfigured(setup: VoiceSetup): boolean {
  switch (setup.provider) {
    case "openai":
      return setup.hasOpenAiKey;
    case "groq":
      return setup.hasGroqKey;
    case "whispercpp":
      // Either half is enough: a managed install, or an external server the
      // user chose to point at.
      return setup.whisperInstalled || setup.whisperEndpointOverridden;
    default:
      return false;
  }
}
