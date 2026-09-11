/**
 * Restore-time admission: the Windows resource guard refuses a launch while
 * the agents restored a few seconds earlier still hold their 30-second
 * startup reservations, so the last agent of a full restore (OpenCode's
 * 1.5 GiB workload in particular) is regularly refused on first ask. A refused
 * resume waits and asks again instead of leaving a cold shell prompt that
 * nobody retries.
 */

export const RESUME_ADMISSION_RETRY_MS = 10_000;
export const RESUME_ADMISSION_WINDOW_MS = 180_000;

export type ResumeAdmissionOutcome =
  | { kind: "admitted"; attempts: number }
  | { kind: "abandoned"; attempts: number }
  | { kind: "refused"; attempts: number; error: string };

export type ResumeAdmissionOptions = {
  /** Asks the resource guard once; rejects when there is no headroom. */
  admit: () => Promise<unknown>;
  /** True once the terminal is gone or something else already runs in it. */
  abandoned: () => boolean;
  /** Called after every refused attempt that will be retried. */
  onPaused?: (error: string, attempt: number) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  retryMs?: number;
  windowMs?: number;
};

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const wait = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function admitAgentResume(
  options: ResumeAdmissionOptions,
): Promise<ResumeAdmissionOutcome> {
  const sleep = options.sleep ?? wait;
  const now = options.now ?? Date.now;
  const retryMs = Math.max(0, options.retryMs ?? RESUME_ADMISSION_RETRY_MS);
  const deadline =
    now() + Math.max(0, options.windowMs ?? RESUME_ADMISSION_WINDOW_MS);
  let attempts = 0;
  for (;;) {
    if (options.abandoned()) return { kind: "abandoned", attempts };
    attempts += 1;
    let error: string;
    try {
      await options.admit();
      return { kind: "admitted", attempts };
    } catch (caught) {
      error = describe(caught);
    }
    const remaining = deadline - now();
    if (remaining <= 0) return { kind: "refused", attempts, error };
    options.onPaused?.(error, attempts);
    await sleep(Math.min(retryMs, remaining));
  }
}
