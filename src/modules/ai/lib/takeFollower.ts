import type { PcmTake } from "./pcmCapture";
import { SILENCE_RMS } from "./stt";
import { encodeWav, WHISPER_SAMPLE_RATE } from "./wav";

/** How often a take is looked at for a sentence that has ended. */
const POLL_MS = 250;
/** A breath between sentences: this much silence after speech ends one. */
const PAUSE_SECONDS = 0.8;
/** Silence kept at the end of a sentence, so its last sound is not cut. */
const PAUSE_KEPT_SECONDS = 0.3;
/** Less than this before a pause is more likely a cough than a sentence. */
const MIN_SENTENCE_SECONDS = 1;
/** A clip starts this long before its first sound. */
const LEAD_SECONDS = 0.3;

/**
 * Where a clip from `from` to `to` should start: just before its first
 * sound. A clip that opens on a second of silence makes Whisper repeat the
 * first word it hears ("Here come. Here come.") and costs it time.
 */
export function trimSilence(take: PcmTake, from: number, to: number): number {
  const first = Math.round(from * 10);
  for (let block = first; block < Math.round(to * 10); block += 1) {
    if (take.peak(block / 10, (block + 1) / 10) >= SILENCE_RMS) {
      return Math.max(from, block / 10 - LEAD_SECONDS);
    }
  }
  return from;
}

/** Where the sentence that started at `from` ends, once the user has paused
 * after it; null while they still speak or have not said anything yet. */
export function findSentenceEnd(take: PcmTake, from: number): number | null {
  const pause = take.seconds() - PAUSE_SECONDS;
  if (pause - from < MIN_SENTENCE_SECONDS) return null;
  if (take.peak(pause) >= SILENCE_RMS) return null;
  if (take.peak(from, pause) < SILENCE_RMS) return null;
  return pause + PAUSE_KEPT_SECONDS;
}

export type FollowTakeOptions = {
  take: PcmTake;
  /** False once the take stopped recording. */
  recording: () => boolean;
  /** False once the take was cancelled: nothing more is typed then. */
  wanted: () => boolean;
  transcribe: (wav: Blob, seconds: number) => Promise<string>;
  /** Types one sentence; false when it could not. */
  type: (text: string) => Promise<boolean>;
  log: (detail: string) => void;
};

/** What a hands-free take leaves for its end. */
export type TakeRest = {
  /** Where the audio still to be transcribed starts, in seconds. */
  from: number;
  /** Sentences transcribed after typing stopped working, in order. */
  untyped: string[];
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Types a hands-free take sentence by sentence, as soon as the user pauses
 * after each one. None of it can fail the take. A sentence that cannot be
 * transcribed goes with the end of the take instead, and one that cannot be
 * typed is handed back for the end to deal with, after which typing stops:
 * text typed in the wrong place cannot be taken back.
 */
export function followTake(options: FollowTakeOptions): {
  rest(): Promise<TakeRest>;
} {
  const { take, recording, wanted, transcribe, type, log } = options;
  let stopped = false;
  /** Where the next sentence starts. */
  let floor = 0;
  let restFrom = 0;
  const untyped: string[] = [];
  let typing = true;
  let sentenceJob: Promise<void> | null = null;

  const typeSentence = async (from: number, to: number) => {
    let words: string;
    try {
      const wav = encodeWav(take.slice(from, to), WHISPER_SAMPLE_RATE);
      words = (await transcribe(wav, to - from)).trim();
    } catch (error) {
      typing = false;
      restFrom = from;
      log(`a hands-free sentence went unread: ${errorText(error)}`);
      return;
    }
    if (!wanted() || !words) return;
    if (await type(words)) return;
    typing = false;
    untyped.push(words);
  };

  const run = async () => {
    while (!stopped && recording()) {
      if (typing && !sentenceJob) {
        const end = findSentenceEnd(take, floor);
        if (end !== null) {
          const from = trimSilence(take, floor, end);
          floor = end;
          restFrom = end;
          sentenceJob = typeSentence(from, end).finally(() => {
            sentenceJob = null;
          });
        }
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  };
  void run();

  return {
    async rest() {
      stopped = true;
      // The sentence on its way is typed before the end of the take.
      while (sentenceJob) await sentenceJob;
      return { from: restFrom, untyped };
    },
  };
}
