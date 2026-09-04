import { usePreferencesStore } from "@/modules/settings/preferences";
import { setWhispercppBaseURL } from "@/modules/settings/store";
import {
  getWhisperRuntimeStatus,
  startWhisperRuntime,
  stopWhisperRuntime,
} from "@/modules/voice/lib/whisperRuntime";
import { useEffect, useRef } from "react";

export function WhisperRuntimeBridge() {
  const hydrated = usePreferencesStore((state) => state.hydrated);
  const provider = usePreferencesStore((state) => state.sttProvider);
  const autoStart = usePreferencesStore((state) => state.whispercppAutoStart);
  const model = usePreferencesStore((state) => state.whispercppModel);
  const attemptedModelRef = useRef<string | null>(null);

  // Leaving the local provider hides the whole runtime panel, and with it the
  // only Stop button in the app. A server left behind that way holds its model
  // in memory for the rest of the session with nothing able to reach it, so
  // release it here rather than stranding it.
  useEffect(() => {
    if (!hydrated || provider === "whispercpp") return;
    let disposed = false;
    void getWhisperRuntimeStatus()
      .then((status) => {
        if (disposed || !status.running) return null;
        return stopWhisperRuntime();
      })
      .catch((error) => {
        console.error("could not stop the managed Whisper runtime", error);
      });
    return () => {
      disposed = true;
    };
  }, [hydrated, provider]);

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
