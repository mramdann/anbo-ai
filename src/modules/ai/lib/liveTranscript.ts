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

export type LiveRequest = { from: number; to: number };

/** The stretch of the take to transcribe next, or null when nothing new
 * was said since `sentUpTo`. */
export function planLiveRequest(
  take: PcmTake,
  sentUpTo: number,
): LiveRequest | null {
  const to = take.seconds();
  if (to < LIVE_MIN_SECONDS || to - sentUpTo < LIVE_MIN_NEW_SECONDS) {
    return null;
  }
  // Nothing above room noise since the last request: the text shown still
  // stands, and Whisper would only make words up for the silence.
  if (take.peak(sentUpTo, to) < SILENCE_RMS) return null;
  return { from: Math.max(0, to - LIVE_WINDOW_SECONDS), to };
}

/** The caption for a live answer. Whisper marks sounds it does not take for
 * speech in brackets ("[BLANK_AUDIO]", "[Music]"); a window that starts
 * after the take did is shown as cut. */
export function liveCaption(text: string, from: number): string | null {
  const words = text
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!words) return null;
  return from > 0 ? `… ${words}` : words;
}
