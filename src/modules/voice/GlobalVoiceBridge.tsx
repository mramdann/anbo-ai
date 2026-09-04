import { usePreferencesStore } from "@/modules/settings/preferences";
import { setGlobalVoiceRuntimeEnabled } from "@/modules/voice/lib/globalVoice";
import { useEffect, useRef } from "react";

const INTERNAL_VOICE_TARGET_ATTRIBUTE = "data-anbo-voice-target";
const INTERNAL_VOICE_TARGET_SELECTOR = [
  "textarea.xterm-helper-textarea",
  ".cm-content[contenteditable=true]",
  "input:not([type=password])",
  "textarea:not(.xterm-helper-textarea)",
  "[contenteditable=true]:not(.cm-content)",
].join(",");

function clearInternalVoiceTarget() {
  document
    .querySelectorAll(`[${INTERNAL_VOICE_TARGET_ATTRIBUTE}]`)
    .forEach((element) => {
      element.removeAttribute(INTERNAL_VOICE_TARGET_ATTRIBUTE);
    });
}

export function GlobalVoiceBridge({ visible }: { visible: boolean }) {
  const hydrated = usePreferencesStore((state) => state.hydrated);
  const enabled = usePreferencesStore((state) => state.globalVoiceEnabled);
  const appliedRef = useRef<boolean | null>(null);
  const runtimeEnabled = enabled && visible;

  useEffect(() => {
    const rememberInternalInput = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (!target.matches(INTERNAL_VOICE_TARGET_SELECTOR)) return;
      clearInternalVoiceTarget();
      target.setAttribute(INTERNAL_VOICE_TARGET_ATTRIBUTE, "true");
    };
    const clearInternalInputTarget = (event: PointerEvent) => {
      const target = event.target;
      if (
        !(target instanceof Element) ||
        !target.closest(
          ".xterm, .cm-editor, input, textarea, [contenteditable=true]",
        )
      ) {
        clearInternalVoiceTarget();
      }
    };
    document.addEventListener("focusin", rememberInternalInput, true);
    document.addEventListener("pointerdown", clearInternalInputTarget, true);

    return () => {
      document.removeEventListener("focusin", rememberInternalInput, true);
      document.removeEventListener(
        "pointerdown",
        clearInternalInputTarget,
        true,
      );
      clearInternalVoiceTarget();
    };
  }, []);

  useEffect(() => {
    if (!hydrated || appliedRef.current === runtimeEnabled) return;
    appliedRef.current = runtimeEnabled;
    void setGlobalVoiceRuntimeEnabled(runtimeEnabled).catch((error) => {
      appliedRef.current = null;
      console.error("global AnboVoice lifecycle failed", error);
    });
  }, [hydrated, runtimeEnabled]);

  return null;
}
