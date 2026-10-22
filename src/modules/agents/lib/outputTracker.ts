import { redactSensitive } from "@/modules/ai/lib/redact";

/** The most one read returns. */
const MAX_OUTPUT_CHARS = 12_000;
const DEFAULT_OUTPUT_CHARS = 4_000;
/** Redacted output kept per source between reads. */
const OUTPUT_HISTORY_CHARS = 64_000;
/** How many of the last snapshot's lines a new one must start with to count
 *  as the old one scrolled on. A prompt line alone matched the prompt that
 *  started an older window, and a read replayed 400 rows of old output as new
 *  (round 60). */
const MIN_CONTINUED_LINES = 3;

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

export type OutputSpan = {
  text: string;
  /** The cursor at an index of `text`, for reading on from there. */
  cursorAt: (index: number) => string;
  /** The cursor did not apply: `text` is all the kept output. */
  reset: boolean;
  /** The output at the cursor was dropped from the kept history: `text`
   *  is newer than the cursor, and what came first is gone. */
  dropped: boolean;
};

/** Output as the tracker keeps it: redacted, and at most its history size. */
export function keptOutput(rawOutput: string): string {
  return redactSensitive(rawOutput).slice(-OUTPUT_HISTORY_CHARS);
}

/** A read's size: whole numbers kept within 1 to the most one read returns. */
export function clampMaxChars(requested: unknown): number {
  return typeof requested === "number" && Number.isInteger(requested)
    ? Math.max(1, Math.min(MAX_OUTPUT_CHARS, requested))
    : DEFAULT_OUTPUT_CHARS;
}

/**
 * Every length of a prefix of `current` that `previous` ends with, longest
 * first. The KMP failure function over both keeps this linear: a scrolled
 * 64 KB screen overlaps the last one by almost all of it, which a plain loop
 * would test line by line.
 */
function suffixPrefixOverlaps(previous: string, current: string): number[] {
  const limit = Math.min(previous.length, current.length);
  if (limit === 0) return [];
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
  const overlaps: number[] = [];
  for (let length = Math.min(table[table.length - 1], limit); length > 0; ) {
    overlaps.push(length);
    length = table[length - 1];
  }
  return overlaps;
}

function lineCount(text: string): number {
  if (!text) return 0;
  let breaks = 0;
  for (let index = text.indexOf("\n"); index >= 0; ) {
    breaks += 1;
    index = text.indexOf("\n", index + 1);
  }
  return text.endsWith("\n") ? breaks : breaks + 1;
}

/** The longest overlap that starts a line of `previous` and keeps enough of
 *  its lines, or null. */
function lineOverlap(previous: string, current: string): number | null {
  const needed = Math.min(MIN_CONTINUED_LINES, lineCount(previous));
  for (const overlap of suffixPrefixOverlaps(previous, current)) {
    const start = previous.length - overlap;
    if (start > 0 && previous[start - 1] !== "\n") continue;
    // Shorter overlaps keep fewer lines still.
    return lineCount(previous.slice(start)) >= needed ? overlap : null;
  }
  return null;
}

/**
 * Where `current` goes on from `previous`: the index of its first new
 * character, and whether a line break comes first because `previous`'s last
 * line was rewritten in place (a progress line, an edited prompt). Null when
 * `current` does not continue it: a clear, a repaint, or a view that shares
 * only a line or two with it.
 */
function continuationOf(
  previous: string,
  current: string,
): { from: number; separate: boolean } | null {
  if (current.startsWith(previous)) {
    return { from: previous.length, separate: false };
  }
  const whole = lineOverlap(previous, current);
  if (whole !== null) return { from: whole, separate: false };
  const lastBreak = previous.lastIndexOf("\n");
  if (lastBreak < 0 || lastBreak === previous.length - 1) return null;
  const head = previous.slice(0, lastBreak + 1);
  const rest = current.startsWith(head)
    ? head.length
    : lineOverlap(head, current);
  return rest === null ? null : { from: rest, separate: true };
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
    const current = keptOutput(rawOutput);
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
      const next = continuationOf(state.snapshot, current);
      if (!next) {
        state.generation += 1;
        state.snapshot = current;
        state.stream = current;
        state.base = 0;
        state.total = current.length;
        repainted = true;
      } else {
        const appended = `${next.separate ? "\n" : ""}${current.slice(next.from)}`;
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
    const maxChars = clampMaxChars(requestedMaxChars);
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

  /** Everything kept from `cursor` to the end, with cursors into it, for an
   *  answer cut its own way (terminal_wait keeps a command's start and end).
   *  After a repaint, or for a cursor that no longer applies, it is all the
   *  kept output, flagged reset. */
  span(id: string, rawOutput: string, cursor: unknown): OutputSpan {
    const { state, repainted } = this.update(id, rawOutput);
    const parsed = this.parseCursor(cursor);
    const reset =
      repainted ||
      !parsed ||
      parsed.generation !== state.generation ||
      parsed.offset < state.base ||
      parsed.offset > state.total;
    const start = parsed && !reset ? parsed.offset : state.base;
    const { generation } = state;
    return {
      text: state.stream.slice(start - state.base),
      cursorAt: (index) => this.cursorAt(generation, start + index),
      reset,
      dropped:
        !repainted &&
        parsed?.generation === state.generation &&
        parsed.offset < state.base,
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
