import { usePreferencesStore } from "@/modules/settings/preferences";
import { setWhispercppBaseURL } from "@/modules/settings/store";
import {
  getWhisperRuntimeStatus,
  startWhisperRuntime,
} from "@/modules/voice/lib/whisperRuntime";
import { useEffect, useRef } from "react";

export function WhisperRuntimeBridge() {
  const hydrated = usePreferencesStore((state) => state.hydrated);
  const provider = usePreferencesStore((state) => state.sttProvider);
  const autoStart = usePreferencesStore((state) => state.whispercppAutoStart);
  const model = usePreferencesStore((state) => state.whispercppModel);
  const attemptedModelRef = useRef<string | null>(null);

  useEffect(() => {
    if (!hydrated || provider !== "whispercpp" || !autoStart) {
      attemptedModelRef.current = null;
      return;
    }
    if (attemptedModelRef.current === model) return;
    attemptedModelRef.current = model;
    let disposed = false;
    void getWhisperRuntimeStatus()
      .then((status) => {
        if (
          disposed ||
          status.running ||
          !status.installedModels.includes(model)
        ) {
          return null;
        }
        return startWhisperRuntime(model);
      })
      .then((status) => {
        if (!disposed && status?.baseUrl) {
          return setWhispercppBaseURL(status.baseUrl);
        }
      })
      .catch((error) => {
        console.error("managed Whisper startup failed", error);
      });
    return () => {
      disposed = true;
    };
  }, [autoStart, hydrated, model, provider]);

  return null;
}
