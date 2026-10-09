import type { SttProvider, VoiceLiveSource } from "../config";
import type { PcmTake } from "./pcmCapture";
import { SILENCE_RMS } from "./stt";

/** The caption shows its last three lines, about ten seconds of speech, so
 * a long take sends only its end; a shorter window is a faster answer. */
export const LIVE_WINDOW_SECONDS = 12;
/** Shorter audio seldom holds a whole word. */
const LIVE_MIN_SECONDS = 1;
/** Less new audio than this mostly repeats the last answer. */
const LIVE_MIN_NEW_SECONDS = 0.5;
/** How often a take is looked at for something new to send. */
export const LIVE_POLL_MS = 250;
/** Three failures in a row end live text for the take; the final text does
 * not depend on it. */
export const LIVE_MAX_FAILURES = 3;
/** A breath between sentences: this much silence after speech ends one. */
const PAUSE_SECONDS = 0.8;
/** Silence kept at the end of a sentence, so its last sound is not cut. */
const PAUSE_KEPT_SECONDS = 0.3;
/** Less than this before a pause is more likely a cough than a sentence. */
const MIN_SENTENCE_SECONDS = 1;
/** A clip starts this long before its first sound. */
const LEAD_SECONDS = 0.3;

/** Which service shows text while the user speaks, or null for none. */
export function liveProvider(
  source: VoiceLiveSource,
  provider: SttProvider,
): SttProvider | null {
  if (source === "off") return null;
  return source === "local" ? "whispercpp" : provider;
}

/** The time from one live request to the next. */
export function liveIntervalMs(provider: SttProvider): number {
  // Groq's free tier allows 20 requests a minute in all; see groqQuota.
  if (provider === "groq") return 3_000;
  // OpenAI bills every request.
  if (provider === "openai") return 2_000;
  // A preview window keeps local answers to a few hundred milliseconds.
  return 1_000;
}

/** When the next live request may go, for one sent at `sentAt` and
 * answered at `answeredAt`. The provider's interval is stretched so that
 * live text takes at most half of the server's time: the final request then
 * seldom waits behind one, and a local server leaves half the machine to
 * everything else. */
export function nextLiveRequestAt(
  provider: SttProvider,
  sentAt: number,
  answeredAt: number,
): number {
  return sentAt + Math.max(liveIntervalMs(provider), 2 * (answeredAt - sentAt));
}

/** `cut`: the window starts after what was said first and shows so. */
export type LiveRequest = { from: number; to: number; cut: boolean };

/**
 * Where a clip from `from` to `to` should start: just before its first
 * sound. A clip that opens on a second of silence and ends on a word cut
 * short makes Whisper repeat that word ("Here come. Here come."), which on a
 * busy local server took up to 5 s instead of 0.2 s.
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

/** The stretch of the take to transcribe next, or null when nothing new
 * was said since `sentUpTo`. Audio before `floor` was typed already. */
export function planLiveRequest(
  take: PcmTake,
  sentUpTo: number,
  floor = 0,
): LiveRequest | null {
  const to = take.seconds();
  const since = Math.max(sentUpTo, floor);
  if (to - floor < LIVE_MIN_SECONDS || to - since < LIVE_MIN_NEW_SECONDS) {
    return null;
  }
  // Nothing above room noise since the last request: the text shown still
  // stands, and Whisper would only make words up for the silence.
  if (take.peak(since, to) < SILENCE_RMS) return null;
  const cut = to - LIVE_WINDOW_SECONDS > floor;
  const from = cut ? to - LIVE_WINDOW_SECONDS : trimSilence(take, floor, to);
  // Half a second of a new word reads as "n".
  if (to - from < LIVE_MIN_SECONDS) return null;
  return { from, to, cut };
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

/** The caption for a live answer. Whisper marks sounds it does not take for
 * speech in brackets ("[BLANK_AUDIO]", "[Music]"); a `cut` window starts
 * after what the user said first and is shown as such. */
export function liveCaption(text: string, cut: boolean): string | null {
  const words = text
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!words) return null;
  return cut ? `… ${words}` : words;
}
