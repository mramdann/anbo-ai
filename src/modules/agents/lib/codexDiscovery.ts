export type CodexSessionLookup = () => Promise<string | null>;

type PollCodexSessionOptions = {
  timeoutMs?: number;
  intervalMs?: number;
  now?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
  isCurrent?: () => boolean;
};

const defaultSleep = (delayMs: number) =>
  new Promise<void>((resolve) => window.setTimeout(resolve, delayMs));

export async function pollCodexSession(
  lookup: CodexSessionLookup,
  {
    timeoutMs = 30_000,
    intervalMs = 500,
    now = Date.now,
    sleep = defaultSleep,
    isCurrent = () => true,
  }: PollCodexSessionOptions = {},
): Promise<string | null> {
  const deadline = now() + timeoutMs;
  for (;;) {
    if (!isCurrent()) return null;
    const sessionId = await lookup();
    if (!isCurrent()) return null;
    if (sessionId) return sessionId;

    const remaining = deadline - now();
    if (remaining <= 0) {
      const finalSessionId = await lookup();
      return isCurrent() ? finalSessionId : null;
    }
    await sleep(Math.min(intervalMs, remaining));
  }
}
