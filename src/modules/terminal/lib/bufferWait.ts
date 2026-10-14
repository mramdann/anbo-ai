/**
 * Leaves on screen that found every live buffer held. The tab the user just
 * left gives its buffer back only after an asynchronous foreground check, so a
 * switch at a full pool reported the pool full and left the new tab blank
 * although a buffer freed a moment later. A waiting leaf gets the next buffer
 * that frees, and is reported once, only if none freed within `waitMs`.
 */
export class BufferWaitList {
  // The report timer, or null once the leaf was reported and waits on.
  private readonly waiting = new Map<
    number,
    ReturnType<typeof setTimeout> | null
  >();
  private retryQueued = false;

  constructor(private readonly waitMs: number) {}

  get size(): number {
    return this.waiting.size;
  }

  /** Starts a wait; `report` runs once if the leaf still waits by then. */
  wait(leafId: number, report: () => void): void {
    if (this.waiting.has(leafId)) return;
    const timer = setTimeout(() => {
      if (!this.waiting.has(leafId)) return;
      this.waiting.set(leafId, null);
      report();
    }, this.waitMs);
    this.waiting.set(leafId, timer);
  }

  /** Ends a wait, and says whether the leaf had already been reported. */
  stop(leafId: number): boolean {
    if (!this.waiting.has(leafId)) return false;
    const timer = this.waiting.get(leafId);
    if (timer) clearTimeout(timer);
    this.waiting.delete(leafId);
    return timer === null;
  }

  /** A buffer may have freed: runs `attempt` for each waiting leaf, never
   *  inside the release or acquisition that freed it. */
  retrySoon(attempt: (leafId: number) => void): void {
    if (this.waiting.size === 0 || this.retryQueued) return;
    this.retryQueued = true;
    setTimeout(() => {
      this.retryQueued = false;
      for (const leafId of [...this.waiting.keys()]) attempt(leafId);
    }, 0);
  }
}
