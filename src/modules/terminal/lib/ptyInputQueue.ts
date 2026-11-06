const PLAIN_TEXT = /^[^\x00-\x1f\x7f]+$/;

type Caller = {
  resolve: () => void;
  reject: (cause: unknown) => void;
};

type Batch = {
  data: string;
  plain: boolean;
  callers: Caller[];
};

/**
 * Keeps a terminal's input in the order it was typed. Two writes in flight can
 * land either way round: one waiting for its CORS preflight is overtaken by a
 * later one that finds the answer cached. So each waits for the answer to the
 * one before it.
 *
 * Plain text waiting for its turn joins into one write, so typing keeps up
 * while answers are slow. Everything else stays apart, because what it means
 * can depend on arriving alone: a lone Esc read with the next key is Alt+key,
 * and a CLI takes an Enter that comes with text for a newline in its box.
 */
export class PtyInputQueue {
  private readonly waiting: Batch[] = [];
  private sending = false;
  private closedBy: Error | null = null;

  constructor(
    private readonly send: (data: string) => Promise<void>,
    private readonly answerLimitMs: number,
  ) {}

  write(data: string): Promise<void> {
    if (this.closedBy) return Promise.reject(this.closedBy);
    return new Promise<void>((resolve, reject) => {
      const caller = { resolve, reject };
      if (!this.sending) {
        this.start(data, [caller]);
        return;
      }
      const plain = PLAIN_TEXT.test(data);
      const last = this.waiting[this.waiting.length - 1];
      if (plain && last?.plain) {
        last.data += data;
        last.callers.push(caller);
      } else {
        this.waiting.push({ data, plain, callers: [caller] });
      }
    });
  }

  /** What still waits is refused; a write already out gets its own answer. */
  close(reason: Error): void {
    this.closedBy = reason;
    for (const batch of this.waiting.splice(0)) {
      for (const caller of batch.callers) caller.reject(reason);
    }
  }

  private start(data: string, callers: Caller[]): void {
    this.sending = true;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      clearTimeout(limit);
      const next = this.waiting.shift();
      if (next) this.start(next.data, next.callers);
      else this.sending = false;
    };
    // A lost answer must not lock the terminal; the late answer changes nothing.
    const limit = setTimeout(release, this.answerLimitMs);
    new Promise<void>((done) => done(this.send(data))).then(
      () => {
        for (const caller of callers) caller.resolve();
        release();
      },
      (cause: unknown) => {
        for (const caller of callers) caller.reject(cause);
        release();
      },
    );
  }
}
