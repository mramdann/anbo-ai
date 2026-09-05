import { WHISPERCPP_DEFAULT_BASE_URL } from "@/modules/ai/config";
import { useChatStore } from "@/modules/ai/store/chatStore";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  getWhisperRuntimeStatus,
  WHISPER_RUNTIME_PROGRESS_EVENT,
} from "@/modules/voice/lib/whisperRuntime";
import { isVoiceConfigured } from "@/modules/voice/lib/voiceReadiness";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";

/**
 * Whether voice input is set up well enough to offer.
 *
 * The managed runtime is installed from the Settings window, which cannot tell
 * this one directly, so the answer is refreshed when the provider changes and
 * when an install reports progress. Both are events; nothing polls.
 */
export function useVoiceConfigured(): boolean {
  const hydrated = usePreferencesStore((state) => state.hydrated);
  const provider = usePreferencesStore((state) => state.sttProvider);
  const baseURL = usePreferencesStore((state) => state.whispercppBaseURL);
  const apiKeys = useChatStore((state) => state.apiKeys);
  const [whisperInstalled, setWhisperInstalled] = useState(false);

  useEffect(() => {
    if (!hydrated || provider !== "whispercpp") return;
    let disposed = false;
    const refresh = () => {
      void getWhisperRuntimeStatus()
        .then((status) => {
          if (!disposed) setWhisperInstalled(status.installed);
        })
        .catch(() => {
          if (!disposed) setWhisperInstalled(false);
        });
    };
    refresh();
    let unlisten: (() => void) | undefined;
    // An install finishing is the one moment this answer changes on its own,
    // and "finalizing" is that moment. Refreshing on every tick would put a
    // status round trip behind each 150 ms of a 465 MB download.
    void listen<{ phase?: string }>(WHISPER_RUNTIME_PROGRESS_EVENT, (event) => {
      if (event.payload?.phase === "finalizing") refresh();
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [hydrated, provider]);

  if (!hydrated) return false;
  return isVoiceConfigured({
    provider,
    hasOpenAiKey: !!apiKeys.openai,
    hasGroqKey: !!apiKeys.groq,
    whisperInstalled,
    whisperEndpointOverridden:
      !!baseURL && baseURL !== WHISPERCPP_DEFAULT_BASE_URL,
  });
}
