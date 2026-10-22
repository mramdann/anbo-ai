/** One message of a PTY's output stream, as `pty/output.rs` frames it: a kind
 *  byte, then the stream offset of the first byte (little endian) and the
 *  bytes, or the shell's exit code. */
export type PtyMessage =
  | { kind: "data"; offset: number; bytes: Uint8Array }
  | { kind: "exit"; code: number };

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
};

export const freshWatch = (): StreamWatch => ({ behindAt: null, missing: 0 });

/**
 * One watchdog check of a stream that holds everything before `received`.
 * A Tauri channel that loses a message parks every later one, silently: the
 * terminal looked idle for an hour while its shell had run the command. A
 * stream that stays behind Rust's for a whole check, or whose send failed,
 * gets a new channel; one Rust no longer knows twice in a row is gone.
 */
export function watchStream(
  watch: StreamWatch,
  status: PtyOutputStatus | undefined,
  received: number,
): { watch: StreamWatch; action: "none" | "reattach" | "gone" } {
  if (!status) {
    const missing = watch.missing + 1;
    return {
      watch: { behindAt: null, missing },
      action: missing >= 2 ? "gone" : "none",
    };
  }
  if (status.broken) return { watch: freshWatch(), action: "reattach" };
  const behind = status.sent > received || status.exitPending;
  if (!behind) return { watch: freshWatch(), action: "none" };
  if (watch.behindAt === received) {
    return { watch: freshWatch(), action: "reattach" };
  }
  return { watch: { behindAt: received, missing: 0 }, action: "none" };
}
