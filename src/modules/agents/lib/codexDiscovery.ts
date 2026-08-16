export type CodexSessionLookup = () => Promise<string | null>;

type PollCodexSessionOptions = {
  timeoutMs?: number;
  intervalMs?: number;
  now?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
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
  }: PollCodexSessionOptions = {},
): Promise<string | null> {
  const deadline = now() + timeoutMs;
  for (;;) {
    const sessionId = await lookup();
    if (sessionId) return sessionId;

    const remaining = deadline - now();
    if (remaining <= 0) return lookup();
    await sleep(Math.min(intervalMs, remaining));
  }
}
