/** One message of a PTY's output stream, as `pty/output.rs` frames it: a kind
 *  byte, then the stream offset of the first byte (little endian) and the
 *  bytes, or the shell's exit code. */
export type PtyMessage =
  | { kind: "data"; offset: number; bytes: Uint8Array }
  | { kind: "exit"; code: number };

/** A message as the channel delivers it: raw bytes, or the same bytes as
 *  base64 text. */
export type PtyWireMessage = ArrayBuffer | string;

/**
 * A message's bytes, whichever way Rust sent it. One of up to about 6 KB
 * comes as base64 text, because Tauri evaluates a short text body in place
 * and makes the page fetch a raw body of 1 KB or more (`pty/output.rs` has
 * the measurement); a larger one still comes raw.
 */
export function ptyMessageBuffer(message: PtyWireMessage): ArrayBuffer {
  if (typeof message !== "string") return message;
  const binary = atob(message);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

export function parsePtyMessage(buffer: ArrayBuffer): PtyMessage | null {
  const view = new DataView(buffer);
  if (buffer.byteLength >= 9 && view.getUint8(0) === 0) {
    return {
      kind: "data",
      offset: Number(view.getBigUint64(1, true)),
      bytes: new Uint8Array(buffer, 9),
    };
  }
  if (buffer.byteLength === 5 && view.getUint8(0) === 1) {
    return { kind: "exit", code: view.getInt32(1, true) };
  }
  return null;
}

/** What a data message adds to a stream holding everything before
 *  `received`: the part not seen yet (a message sent again after a stall
 *  overlaps), and how many bytes went missing before it. */
export function unseenPart(
  received: number,
  offset: number,
  bytes: Uint8Array,
): { part: Uint8Array | null; lost: number; received: number } {
  const end = offset + bytes.length;
  if (end <= received) return { part: null, lost: 0, received };
  if (offset >= received) {
    return { part: bytes, lost: offset - received, received: end };
  }
  return { part: bytes.subarray(received - offset), lost: 0, received: end };
}

/** Written where output went missing. The reset keeps half an escape
 *  sequence from garbling what follows. */
export function lostOutputNotice(lost: number): string {
  return `\x1bc\x1b[2m[anbo: ${lost} bytes of output were lost]\x1b[0m\r\n`;
}

/** Rust's view of one stream (`pty_output_status`). */
export type PtyOutputStatus = {
  id: number;
  /** The current channel was handed everything before this offset. */
  sent: number;
  end: number;
  /** A send failed; nothing more goes out until a new channel is attached. */
  broken: boolean;
  /** The shell exited and its exit code was not handed to the UI yet. */
  exitPending: boolean;
};

export type StreamWatch = {
  /** What the stream held at the last check that found it behind. */
  behindAt: number | null;
  /** Checks in a row that did not find the session at all. */
  missing: number;
  /** Checks in a row that found it behind and holding the same. */
  stuck: number;
  /** How many such checks make it ask for a new channel. */
  patience: number;
};

/** A stream behind for two checks in a row asks for a new channel. */
const FIRST_PATIENCE = 2;
/** The longest it waits between two asks, in checks. */
const MOST_PATIENCE = 16;

export const freshWatch = (): StreamWatch => ({
  behindAt: null,
  missing: 0,
  stuck: 0,
  patience: FIRST_PATIENCE,
});

/**
 * One watchdog check of a stream that holds everything before `received`.
 * A Tauri channel that loses a message parks every later one, silently: the
 * terminal looked idle for an hour while its shell had run the command. A
 * stream that stays behind Rust's for a whole check, or whose send failed,
 * gets a new channel; one Rust no longer knows twice in a row is gone.
 *
 * A new channel makes Rust send again everything the stream does not hold.
 * When the page itself is too busy to take its output, that does not help and
 * is more for it to take, so a stream that asked and still holds the same
 * waits twice as many checks before it asks again (round 113: one stalled for
 * 40 s asked 14 times). It is back to two checks once it moves.
 */
export function watchStream(
  watch: StreamWatch,
  status: PtyOutputStatus | undefined,
  received: number,
): { watch: StreamWatch; action: "none" | "reattach" | "gone" } {
  if (!status) {
    const missing = watch.missing + 1;
    return {
      watch: { ...freshWatch(), missing },
      action: missing >= 2 ? "gone" : "none",
    };
  }
  if (status.broken) return { watch: freshWatch(), action: "reattach" };
  const behind = status.sent > received || status.exitPending;
  if (!behind) return { watch: freshWatch(), action: "none" };
  if (watch.behindAt !== received) {
    return {
      watch: { ...freshWatch(), behindAt: received, stuck: 1 },
      action: "none",
    };
  }
  const stuck = watch.stuck + 1;
  if (stuck < watch.patience) {
    return { watch: { ...watch, missing: 0, stuck }, action: "none" };
  }
  return {
    watch: {
      behindAt: received,
      missing: 0,
      stuck: 0,
      patience: Math.min(watch.patience * 2, MOST_PATIENCE),
    },
    action: "reattach",
  };
}
