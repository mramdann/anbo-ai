// Loaded with the first alert or preview, so the sound recipes stay out of
// the startup bundles of the main and settings windows.
import {
  type AttentionSoundId,
  audioContext,
  DEFAULT_ATTENTION_SOUND,
} from "./attentionSound";

/**
 * One oscillator. Its gain rises from silence through `envelope`, points of
 * [seconds after `at`, gain] joined by exponential ramps; `glide` bends the
 * pitch to [frequency, seconds after `at`].
 */
type Voice = {
  type: OscillatorType;
  frequency: number;
  glide?: readonly [number, number];
  at: number;
  envelope: readonly (readonly [number, number])[];
};

// Synthesized, so no audio file ships and nothing loads before an alert.
// Peaks stay near the chirp's 0.18, so changing the sound keeps the loudness.
const VOICES: Record<Exclude<AttentionSoundId, "none">, readonly Voice[]> = {
  chirp: [
    {
      type: "triangle",
      frequency: 720,
      glide: [960, 0.14],
      at: 0,
      envelope: [
        [0.02, 0.18],
        [0.14, 0.09],
        [0.36, 0.0001],
      ],
    },
  ],
  chime: [
    {
      type: "sine",
      frequency: 783.99,
      at: 0,
      envelope: [
        [0.01, 0.16],
        [0.55, 0.0001],
      ],
    },
    {
      type: "sine",
      frequency: 1046.5,
      at: 0.11,
      envelope: [
        [0.01, 0.16],
        [0.7, 0.0001],
      ],
    },
  ],
  ding: [
    {
      type: "sine",
      frequency: 880,
      at: 0,
      envelope: [
        [0.005, 0.16],
        [1.1, 0.0001],
      ],
    },
    {
      type: "sine",
      frequency: 2428.8,
      at: 0,
      envelope: [
        [0.005, 0.03],
        [0.4, 0.0001],
      ],
    },
  ],
  pop: [
    {
      type: "sine",
      frequency: 880,
      glide: [240, 0.09],
      at: 0,
      envelope: [
        [0.006, 0.22],
        [0.14, 0.0001],
      ],
    },
  ],
  wood: [
    {
      type: "sine",
      frequency: 523.25,
      at: 0,
      envelope: [
        [0.004, 0.2],
        [0.3, 0.0001],
      ],
    },
    {
      type: "sine",
      frequency: 2093,
      at: 0,
      envelope: [
        [0.002, 0.05],
        [0.05, 0.0001],
      ],
    },
  ],
  rise: [
    {
      type: "triangle",
      frequency: 523.25,
      at: 0,
      envelope: [
        [0.01, 0.13],
        [0.2, 0.0001],
      ],
    },
    {
      type: "triangle",
      frequency: 659.25,
      at: 0.08,
      envelope: [
        [0.01, 0.13],
        [0.2, 0.0001],
      ],
    },
    {
      type: "triangle",
      frequency: 783.99,
      at: 0.16,
      envelope: [
        [0.01, 0.14],
        [0.34, 0.0001],
      ],
    },
  ],
};

export function playAttentionSound(
  sound: AttentionSoundId = DEFAULT_ATTENTION_SOUND,
): void {
  if (sound === "none") return;
  const voices = VOICES[sound] ?? VOICES[DEFAULT_ATTENTION_SOUND];
  const audio = audioContext();
  if (!audio) return;
  void playWhenReady(audio, voices);
}

async function playWhenReady(
  audio: AudioContext,
  voices: readonly Voice[],
): Promise<void> {
  try {
    if (audio.state === "suspended") await audio.resume();
    if (audio.state !== "running") return;

    const now = audio.currentTime + 0.005;
    for (const voice of voices) {
      const start = now + voice.at;
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();
      oscillator.type = voice.type;
      oscillator.frequency.setValueAtTime(voice.frequency, start);
      if (voice.glide) {
        oscillator.frequency.exponentialRampToValueAtTime(
          voice.glide[0],
          start + voice.glide[1],
        );
      }
      gain.gain.setValueAtTime(0.0001, start);
      for (const [time, value] of voice.envelope) {
        gain.gain.exponentialRampToValueAtTime(value, start + time);
      }
      oscillator.connect(gain);
      gain.connect(audio.destination);
      const end = voice.envelope[voice.envelope.length - 1]?.[0] ?? 0;
      oscillator.start(start);
      oscillator.stop(start + end + 0.01);
    }
  } catch {
    // Audio must never prevent the attention toast from being shown.
  }
}
