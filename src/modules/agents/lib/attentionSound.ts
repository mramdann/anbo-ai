let context: AudioContext | null = null;

function audioContext(): AudioContext | null {
  const AudioContextConstructor = globalThis.AudioContext;
  if (typeof AudioContextConstructor !== "function") return null;
  context ??= new AudioContextConstructor();
  return context;
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

export function playAttentionSound(): void {
  const audio = audioContext();
  if (!audio) return;
  void playWhenReady(audio);
}

async function playWhenReady(audio: AudioContext): Promise<void> {
  try {
    if (audio.state === "suspended") await audio.resume();
    if (audio.state !== "running") return;

    const now = audio.currentTime + 0.005;
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.type = "triangle";
    oscillator.frequency.setValueAtTime(720, now);
    oscillator.frequency.exponentialRampToValueAtTime(960, now + 0.14);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.18, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.09, now + 0.14);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.36);
    oscillator.connect(gain);
    gain.connect(audio.destination);
    oscillator.start(now);
    oscillator.stop(now + 0.37);
  } catch {
    // Audio must never prevent the attention toast from being shown.
  }
}
