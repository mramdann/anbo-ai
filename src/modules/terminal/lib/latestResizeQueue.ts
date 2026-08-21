export type TerminalSize = {
  cols: number;
  rows: number;
};

export class LatestResizeQueue {
  private pending: TerminalSize | null = null;
  private running: Promise<void> | null = null;
  private disposed = false;

  constructor(private readonly apply: (size: TerminalSize) => Promise<void>) {}

  request(size: TerminalSize): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.pending = size;
    if (!this.running) this.running = this.drain();
    return this.running;
  }

  dispose(): void {
    this.disposed = true;
    this.pending = null;
  }

  private async drain(): Promise<void> {
    let firstError: unknown = null;
    while (!this.disposed && this.pending) {
      const next = this.pending;
      this.pending = null;
      try {
        await this.apply(next);
      } catch (error) {
        firstError ??= error;
      }
    }
    this.running = null;
    if (!this.disposed && this.pending) this.running = this.drain();
    if (firstError !== null) throw firstError;
  }
}
