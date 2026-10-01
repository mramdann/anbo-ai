let context: AudioContext | null = null;

/** One context for the unlock below and for the player that uses it. */
export function audioContext(): AudioContext | null {
  const AudioContextConstructor = globalThis.AudioContext;
  if (typeof AudioContextConstructor !== "function") return null;
  context ??= new AudioContextConstructor();
  return context;
}

/** The alert sounds a user can pick in Settings, in menu order. */
export const ATTENTION_SOUNDS = [
  { id: "chirp", label: "Chirp" },
  { id: "chime", label: "Chime" },
  { id: "ding", label: "Ding" },
  { id: "pop", label: "Pop" },
  { id: "wood", label: "Wood" },
  { id: "rise", label: "Rise" },
  { id: "none", label: "None" },
] as const;

export type AttentionSoundId = (typeof ATTENTION_SOUNDS)[number]["id"];

export const DEFAULT_ATTENTION_SOUND = "chirp" satisfies AttentionSoundId;

export function isAttentionSoundId(value: unknown): value is AttentionSoundId {
  return ATTENTION_SOUNDS.some((sound) => sound.id === value);
}

/**
 * Unlock Web Audio from a real user gesture so background agent attention can
 * play even when the first sound happens after the window loses focus.
 */
export function prepareAttentionSound(): () => void {
  if (typeof window === "undefined") return () => {};

  let listening = true;
  const cleanup = () => {
    if (!listening) return;
    listening = false;
    window.removeEventListener("pointerdown", unlock, true);
    window.removeEventListener("keydown", unlock, true);
  };
  const unlock = () => {
    const audio = audioContext();
    if (!audio || audio.state === "running") {
      cleanup();
      return;
    }
    void audio
      .resume()
      .then(() => {
        if (audio.state === "running") cleanup();
      })
      .catch(() => {});
  };

  window.addEventListener("pointerdown", unlock, {
    capture: true,
    passive: true,
  });
  window.addEventListener("keydown", unlock, true);
  return cleanup;
}
