/**
 * Groq's free tier allows 20 transcription requests a minute and 7,200
 * seconds of audio an hour, and bills every request as at least 10 seconds.
 * Live text sends a request every couple of seconds while the user speaks,
 * so it stays clear of both limits and leaves room for the takes themselves:
 * a dictation that cannot be transcribed at all is worse than one shown late.
 * The counts cover this window's own requests; Groq's 429 answer covers the
 * rest.
 */
const GROQ_FREE_REQUESTS_PER_MINUTE = 20;
const GROQ_FREE_AUDIO_SECONDS_PER_HOUR = 7_200;
const GROQ_MIN_BILLED_SECONDS = 10;
/** Kept free for final transcriptions. */
const RESERVED_REQUESTS = 8;
const RESERVED_AUDIO_SECONDS = 1_200;
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

type Use = { at: number; seconds: number };

export function createGroqQuota() {
  const uses: Use[] = [];
  let blockedUntil = 0;
  const prune = (now: number) => {
    while (uses.length > 0 && now - uses[0].at >= HOUR_MS) uses.shift();
  };
  const billed = (audioSeconds: number) =>
    Math.max(GROQ_MIN_BILLED_SECONDS, Math.ceil(audioSeconds));
  return {
    /** Every request sent, live or final. */
    note(audioSeconds: number, now = Date.now()) {
      prune(now);
      uses.push({ at: now, seconds: billed(audioSeconds) });
    },
    /** Groq answered 429; `retryAfterSeconds` is its retry-after header. */
    rateLimited(retryAfterSeconds: number | null, now = Date.now()) {
      const wait =
        retryAfterSeconds && retryAfterSeconds > 0 ? retryAfterSeconds : 60;
      blockedUntil = Math.max(blockedUntil, now + wait * 1000);
    },
    liveAllowed(audioSeconds: number, now = Date.now()): boolean {
      if (now < blockedUntil) return false;
      prune(now);
      const lastMinute = uses.filter((use) => now - use.at < MINUTE_MS).length;
      const lastHour = uses.reduce((sum, use) => sum + use.seconds, 0);
      return (
        lastMinute < GROQ_FREE_REQUESTS_PER_MINUTE - RESERVED_REQUESTS &&
        lastHour + billed(audioSeconds) <=
          GROQ_FREE_AUDIO_SECONDS_PER_HOUR - RESERVED_AUDIO_SECONDS
      );
    },
  };
}

export type GroqQuota = ReturnType<typeof createGroqQuota>;

/** Shared by everything in this window that calls Groq. */
export const groqQuota = createGroqQuota();
