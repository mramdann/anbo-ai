import type { SttProvider } from "../config";
import {
  findSentenceEnd,
  LIVE_MAX_FAILURES,
  LIVE_POLL_MS,
  liveCaption,
  nextLiveRequestAt,
  planLiveRequest,
  trimSilence,
} from "./liveTranscript";
import type { PcmTake } from "./pcmCapture";
import { encodeWav, WHISPER_SAMPLE_RATE } from "./wav";

type Transcribe = (wav: Blob, seconds: number) => Promise<string>;

export type FollowTakeOptions = {
  take: PcmTake;
  /** False once the take stopped recording. */
  recording: () => boolean;
  /** False once the take was cancelled: nothing more is typed then. */
  wanted: () => boolean;
  live: {
    provider: SttProvider;
    transcribe: Transcribe;
    /** Whether a live request of this many seconds may go now. */
    allowed: (seconds: number) => boolean;
  } | null;
  /** A hands-free take types each sentence once the user pauses after it. */
  sentences: {
    transcribe: Transcribe;
    /** Types one sentence; false when it could not. */
    type: (text: string) => Promise<boolean>;
  } | null;
  /** The words heard and not typed yet, or null to hide them. */
  onLiveText: (text: string | null) => void;
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
 * Follows a take while it records: live text for the caption and, for a
 * hands-free take, each sentence typed as soon as the user pauses after it.
 * None of it can fail the take. A sentence that cannot be transcribed goes
 * with the end of the take instead, and one that cannot be typed is handed
 * back for the end to deal with, after which typing stops: text typed in
 * the wrong place cannot be taken back.
 */
export function followTake(options: FollowTakeOptions): {
  rest(): Promise<TakeRest>;
} {
  const { take, recording, wanted, live, sentences, onLiveText, log } = options;
  let stopped = false;
  /** Where the next sentence starts; live text never looks before it. */
  let floor = 0;
  let restFrom = 0;
  const untyped: string[] = [];
  let typing = sentences !== null;
  let sentenceJob: Promise<void> | null = null;
  let liveJob: Promise<void> | null = null;
  let liveFailures = 0;
  let liveSentUpTo = 0;
  let nextLiveAt = 0;
  /** The floor of the caption on show, or null while none shows. */
  let shownFloor: number | null = null;
  const active = () => !stopped && recording();
  const wav = (from: number, to: number) =>
    encodeWav(take.slice(from, to), WHISPER_SAMPLE_RATE);

  const typeSentence = async (from: number, to: number) => {
    if (!sentences) return;
    let words: string;
    try {
      words = (await sentences.transcribe(wav(from, to), to - from)).trim();
    } catch (error) {
      typing = false;
      restFrom = from;
      log(`a hands-free sentence went unread: ${errorText(error)}`);
      return;
    }
    if (!wanted() || !words) return;
    if (await sentences.type(words)) {
      // The caption showed this sentence; the next words start a new one.
      if (shownFloor !== null && shownFloor < to) {
        shownFloor = null;
        onLiveText(null);
      }
      return;
    }
    typing = false;
    untyped.push(words);
  };

  const askLive = async (from: number, to: number, cut: boolean) => {
    if (!live) return;
    const askedFloor = floor;
    const sentAt = Date.now();
    try {
      const text = await live.transcribe(wav(from, to), to - from);

      if (!active()) return;
      liveSentUpTo = to;
      liveFailures = 0;
      // A sentence that went to typing meanwhile made this answer old.
      if (floor !== askedFloor) return;
      const caption = liveCaption(text, cut);
      if (caption) {
        shownFloor = askedFloor;
        onLiveText(caption);
      }
    } catch (error) {
      if (!active()) return;
      liveFailures += 1;
      if (liveFailures === LIVE_MAX_FAILURES) {
        log(`live text stopped (${live.provider}): ${errorText(error)}`);
      }
    } finally {
      nextLiveAt = nextLiveRequestAt(live.provider, sentAt, Date.now());
    }
  };

  const run = async () => {
    while (active()) {
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
      if (
        live &&
        !liveJob &&
        liveFailures < LIVE_MAX_FAILURES &&
        Date.now() >= nextLiveAt
      ) {
        const request = planLiveRequest(take, liveSentUpTo, floor);
        if (request && live.allowed(request.to - request.from)) {
          liveJob = askLive(request.from, request.to, request.cut).finally(
            () => {
              liveJob = null;
            },
          );
        }
      }
      await new Promise((resolve) => setTimeout(resolve, LIVE_POLL_MS));
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
