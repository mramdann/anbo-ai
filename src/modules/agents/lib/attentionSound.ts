let context: AudioContext | null = null;
let restAt = 0;
let restTimer: ReturnType<typeof setTimeout> | undefined;

/** One context for the unlock below and for the player that uses it. */
export function audioContext(): AudioContext | null {
  const AudioContextConstructor = globalThis.AudioContext;
  if (typeof AudioContextConstructor !== "function") return null;
  context ??= new AudioContextConstructor();
  return context;
}

/**
 * Lets the context run for `seconds` more, then suspends it. A running context
 * renders silence about 100 times a second for as long as it runs: left running
 * after the unlock, it cost the main window about 3% of a core from the first
 * click on (round 109). A context that ran once inside a user gesture resumes
 * later without one, so it rests between sounds. A sound that asked for longer
 * keeps its time.
 */
export function restAudioAfter(audio: AudioContext, seconds: number): void {
  const at = Date.now() + seconds * 1000;
  if (at < restAt) return;
  restAt = at;
  clearTimeout(restTimer);
  restTimer = setTimeout(() => {
    restAt = 0;
    if (audio.state === "running") void audio.suspend().catch(() => {});
  }, seconds * 1000);
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
 * play even when the first sound happens after the window loses focus. The
 * context runs for that moment only: unlocked, it rests until a sound plays.
 */
export function prepareAttentionSound(): () => void {
  if (typeof window === "undefined") return () => {};

  let listening = true;
  const cleanup = () => {
    if (!listening) return;
    listening = false;
    window.removeEventListener("pointerdown", unlock, { capture: true });
    window.removeEventListener("keydown", unlock, { capture: true });
  };
  const unlock = () => {
    const audio = audioContext();
    if (!audio) {
      cleanup();
      return;
    }
    const unlocked = () => {
      if (audio.state !== "running") return;
      cleanup();
      restAudioAfter(audio, 0);
    };
    // A context made inside the gesture runs at once, with no resume.
    if (audio.state === "running") {
      unlocked();
      return;
    }
    void audio
      .resume()
      .then(unlocked)
      .catch(() => {});
  };

  window.addEventListener("pointerdown", unlock, {
    capture: true,
    passive: true,
  });
  window.addEventListener("keydown", unlock, { capture: true });
  return cleanup;
}
