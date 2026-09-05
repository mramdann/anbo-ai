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

/** `configured` comes from the shell, which already asked. Asking again here
 * would double every status round trip for one answer. */
export function GlobalVoiceBridge({ configured }: { configured: boolean }) {
  const hydrated = usePreferencesStore((state) => state.hydrated);
  const enabled = usePreferencesStore((state) => state.globalVoiceEnabled);
  // An orb that cannot transcribe is worse than no orb: the take is recorded
  // and then lost. Keep it away until voice has been set up.
  const runtimeEnabled = enabled && configured;
  // The runtime starts disabled, so seeding this false keeps the default path
  // from spending an IPC round trip turning off something that was never on.
  const appliedRef = useRef(false);

  // Gated on the preference: with the feature off these document wide capture
  // listeners would run for every user on every focus and pointer event.
  useEffect(() => {
    if (!runtimeEnabled) return;
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
  }, [runtimeEnabled]);

  useEffect(() => {
    if (!hydrated || appliedRef.current === runtimeEnabled) return;
    appliedRef.current = runtimeEnabled;
    void setGlobalVoiceRuntimeEnabled(runtimeEnabled).catch((error) => {
      appliedRef.current = !runtimeEnabled;
      console.error("global AnboVoice lifecycle failed", error);
    });
  }, [hydrated, runtimeEnabled]);

  return null;
}
