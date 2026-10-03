import { redactSensitive } from "@/modules/ai/lib/redact";

/** The most one read returns. */
const MAX_OUTPUT_CHARS = 12_000;
const DEFAULT_OUTPUT_CHARS = 4_000;
/** Redacted output kept per source between reads. */
const OUTPUT_HISTORY_CHARS = 64_000;

type OutputState = {
  generation: number;
  snapshot: string;
  stream: string;
  base: number;
  total: number;
};

export type OutputRead = {
  output: string;
  cursor: string;
  /** Output follows the end of this read. */
  hasMore: boolean;
  /** The read starts after output the history already dropped. */
  historyTruncated: boolean;
  /** The source repainted or the cursor no longer applies: the read starts over. */
  reset: boolean;
};

/**
 * The longest prefix of `current` that `previous` ends with. The KMP failure
 * function over both keeps this linear: a scrolled 64 KB screen overlaps the
 * last one by almost all of it, which a plain loop would test line by line.
 */
function suffixPrefixOverlap(previous: string, current: string): number {
  const limit = Math.min(previous.length, current.length);
  if (limit === 0) return 0;
  const prefix = current.slice(0, limit);
  const suffix = previous.slice(-limit);
  const combined = `${prefix}\u0000${suffix}`;
  const table = new Uint32Array(combined.length);
  for (let index = 1; index < combined.length; index += 1) {
    let candidate = table[index - 1];
    while (candidate > 0 && combined[index] !== combined[candidate]) {
      candidate = table[candidate - 1];
    }
    if (combined[index] === combined[candidate]) candidate += 1;
    table[index] = candidate;
  }
  return Math.min(table[table.length - 1], limit);
}

/**
 * Follows what a source shows as one append-only stream that a reader pages
 * through with a cursor. A snapshot that continues the last one appends to the
 * stream; one that shares nothing with it (a clear or a full repaint) starts a
 * new generation, which retires older cursors.
 */
export class OutputTracker {
  private readonly states = new Map<string, OutputState>();

  constructor(
    private readonly cursorPrefix: string,
    private readonly maxSources: number,
  ) {}

  private update(
    id: string,
    rawOutput: string,
  ): { state: OutputState; repainted: boolean } {
    const current = redactSensitive(rawOutput).slice(-OUTPUT_HISTORY_CHARS);
    let state = this.states.get(id);
    let repainted = false;
    if (!state) {
      state = {
        generation: 1,
        snapshot: current,
        stream: current,
        base: 0,
        total: current.length,
      };
      this.states.set(id, state);
      while (this.states.size > this.maxSources) {
        const oldest = this.states.keys().next().value;
        if (oldest === undefined) break;
        this.states.delete(oldest);
      }
    } else if (current !== state.snapshot) {
      const overlap = current.startsWith(state.snapshot)
        ? state.snapshot.length
        : suffixPrefixOverlap(state.snapshot, current);
      if (overlap === 0) {
        state.generation += 1;
        state.snapshot = current;
        state.stream = current;
        state.base = 0;
        state.total = current.length;
        repainted = true;
      } else {
        const appended = current.slice(overlap);
        state.snapshot = current;
        state.stream += appended;
        state.total += appended.length;
        if (state.stream.length > OUTPUT_HISTORY_CHARS) {
          const removed = state.stream.length - OUTPUT_HISTORY_CHARS;
          state.stream = state.stream.slice(removed);
          state.base += removed;
        }
      }
    }
    return { state, repainted };
  }

  /** The cursor just past what `rawOutput` shows now. */
  checkpoint(id: string, rawOutput: string): string {
    const { state } = this.update(id, rawOutput);
    return this.cursorAt(state.generation, state.total);
  }

  read(
    id: string,
    rawOutput: string,
    cursor: unknown,
    requestedMaxChars: unknown,
  ): OutputRead {
    const maxChars =
      typeof requestedMaxChars === "number" &&
      Number.isInteger(requestedMaxChars)
        ? Math.max(1, Math.min(MAX_OUTPUT_CHARS, requestedMaxChars))
        : DEFAULT_OUTPUT_CHARS;
    const { state, repainted } = this.update(id, rawOutput);
    const parsed = this.parseCursor(cursor);
    const cursorInvalid =
      cursor !== undefined &&
      (!parsed ||
        parsed.generation !== state.generation ||
        parsed.offset < state.base ||
        parsed.offset > state.total);
    const reset = repainted || cursorInvalid;
    const start =
      parsed && !reset
        ? parsed.offset
        : Math.max(state.base, state.total - maxChars);
    const output = state.stream.slice(start - state.base).slice(0, maxChars);
    const nextOffset = start + output.length;
    return {
      output,
      cursor: this.cursorAt(state.generation, nextOffset),
      hasMore: nextOffset < state.total,
      historyTruncated: start > state.base,
      reset,
    };
  }

  remove(id: string): void {
    this.states.delete(id);
  }

  private cursorAt(generation: number, offset: number): string {
    return `${this.cursorPrefix}:${generation}:${offset}`;
  }

  private parseCursor(
    cursor: unknown,
  ): { generation: number; offset: number } | null {
    if (typeof cursor !== "string") return null;
    const match = /^([a-z]\d+):(\d+):(\d+)$/.exec(cursor);
    if (!match || match[1] !== this.cursorPrefix) return null;
    const generation = Number(match[2]);
    const offset = Number(match[3]);
    return Number.isSafeInteger(generation) && Number.isSafeInteger(offset)
      ? { generation, offset }
      : null;
  }
}
