import { useCallback, useState } from "react";

const STORE_KEY = "anbo-ui-voice-orb-visible";

function loadVisible(): boolean {
  try {
    return window.localStorage.getItem(STORE_KEY) !== "0";
  } catch {
    return true;
  }
}

export function useVoiceVisibility() {
  const [visible, setVisibleState] = useState(loadVisible);
  const setVisible = useCallback((next: boolean) => {
    setVisibleState(next);
    try {
      window.localStorage.setItem(STORE_KEY, next ? "1" : "0");
    } catch {}
  }, []);
  const toggle = useCallback(() => setVisible(!visible), [setVisible, visible]);
  return { visible, setVisible, toggle };
}
