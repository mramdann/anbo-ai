import { useCallback, useState } from "react";

/**
 * Where the header's AnboVoice toggle keeps its answer. The global orb runs in
 * its own window on the same origin, so it reads this key too and hears the
 * toggle through the storage event; nothing else has to carry the message.
 */
export const VOICE_ORB_VISIBLE_KEY = "anbo-ui-voice-orb-visible";

/** Only an explicit "0" hides the orb; absence and anything else show it. */
export function orbVisibleFromStorage(raw: string | null): boolean {
  return raw !== "0";
}

function loadVisible(): boolean {
  try {
    return orbVisibleFromStorage(
      window.localStorage.getItem(VOICE_ORB_VISIBLE_KEY),
    );
  } catch {
    return true;
  }
}

export function useVoiceVisibility() {
  const [visible, setVisibleState] = useState(loadVisible);
  const setVisible = useCallback((next: boolean) => {
    setVisibleState(next);
    try {
      window.localStorage.setItem(VOICE_ORB_VISIBLE_KEY, next ? "1" : "0");
    } catch {}
  }, []);
  const toggle = useCallback(() => setVisible(!visible), [setVisible, visible]);
  return { visible, setVisible, toggle };
}
