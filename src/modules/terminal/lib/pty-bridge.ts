import { IS_WINDOWS } from "@/lib/platform";
import { currentWorkspaceEnv } from "@/modules/workspace";
import { Channel, invoke } from "@tauri-apps/api/core";
import { warn } from "@tauri-apps/plugin-log";
import { LatestResizeQueue } from "./latestResizeQueue";
import { PtyInputQueue } from "./ptyInputQueue";
import {
  freshWatch,
  lostOutputNotice,
  parsePtyMessage,
  type PtyOutputStatus,
  type StreamWatch,
  unseenPart,
  watchStream,
} from "./ptyStream";
import { encodeWindowsPtyInput } from "./windowsPtyInput";

const textEncoder = new TextEncoder();

export type PtyHandlers = {
  onData: (bytes: Uint8Array) => void;
  onExit?: (code: number) => void;
};

export type PtySession = {
  id: number;
  write: (data: string) => Promise<void>;
  resize: (cols: number, rows: number) => Promise<void>;
  close: () => Promise<void>;
};

/** How often the UI compares each stream with Rust's. */
const WATCH_INTERVAL_MS = 2_000;
/** A status call that never answers must not stop later checks. */
const WATCH_CALL_TIMEOUT_MS = 5_000;
/** How long a replaced channel is still heard: what it gets was late, not
 *  lost. */
const LATE_WINDOW_MS = 5_000;
/** How long a write may stay unanswered before the next one goes anyway. The
 *  slowest under a storm of agents took 1.4 s. */
const WRITE_ANSWER_LIMIT_MS = 5_000;

/**
 * A PTY's output as it reaches the UI: every message carries the stream
 * offset of its first byte, so a message sent again overlaps without
 * repeating, and a gap is marked instead of passing silently.
 */
class PtyStream {
  id = -1;
  received = 0;
  watch: StreamWatch = freshWatch();
  attaching = false;
  /** What the stream held at the last check. */
  checkedAt = 0;
  /** Since when the stream has stood behind Rust's, while it does. */
  stalledSince: number | null = null;
  private ended = false;
  private readonly handlers: PtyHandlers;
  channel: Channel<ArrayBuffer>;

  constructor(handlers: PtyHandlers) {
    this.handlers = handlers;
    this.channel = this.newChannel();
  }

  newChannel(): Channel<ArrayBuffer> {
    const channel = new Channel<ArrayBuffer>();
    channel.onmessage = (buffer) => this.receive(buffer);
    return channel;
  }

  private receive(buffer: ArrayBuffer): void {
    if (this.ended) return;
    const message = parsePtyMessage(buffer);
    if (!message) return;
    if (message.kind === "exit") {
      this.finish(message.code);
      return;
    }
    const { part, lost, received } = unseenPart(
      this.received,
      message.offset,
      message.bytes,
    );
    this.received = received;
    if (lost > 0) {
      console.warn("[anbo] terminal output was lost", this.id, lost);
      this.deliver(textEncoder.encode(lostOutputNotice(lost)));
    }
    if (part) this.deliver(part);
  }

  // A handler that throws must not hold the stream: the channel would wait
  // for this message forever.
  private deliver(bytes: Uint8Array): void {
    try {
      this.handlers.onData(bytes);
    } catch (cause) {
      console.error("[anbo] terminal output handler failed", this.id, cause);
    }
  }

  finish(code: number): void {
    if (this.ended) return;
    this.ended = true;
    stopWatching(this);
    this.channel.onmessage = () => {};
    try {
      this.handlers.onExit?.(code);
    } catch (cause) {
      console.error("[anbo] terminal exit handler failed", this.id, cause);
    }
  }

  stop(): void {
    this.ended = true;
    stopWatching(this);
    this.channel.onmessage = () => {};
  }
}

const watched = new Map<number, PtyStream>();
let watchTimer: ReturnType<typeof setInterval> | null = null;
let checking = false;

function startWatching(stream: PtyStream): void {
  watched.set(stream.id, stream);
  watchTimer ??= setInterval(() => void checkStreams(), WATCH_INTERVAL_MS);
}

function stopWatching(stream: PtyStream): void {
  if (watched.get(stream.id) !== stream) return;
  watched.delete(stream.id);
  if (watched.size === 0 && watchTimer !== null) {
    clearInterval(watchTimer);
    watchTimer = null;
  }
}

function withinTime<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`no answer in ${ms} ms`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (cause: unknown) => {
        clearTimeout(timer);
        reject(cause);
      },
    );
  });
}

async function checkStreams(): Promise<void> {
  if (checking || watched.size === 0) return;
  checking = true;
  try {
    const statuses = await withinTime(
      invoke<PtyOutputStatus[]>("pty_output_status"),
      WATCH_CALL_TIMEOUT_MS,
    );
    const byId = new Map(statuses.map((status) => [status.id, status]));
    const now = Date.now();
    for (const stream of [...watched.values()]) {
      const status = byId.get(stream.id);
      const { watch, action } = watchStream(
        stream.watch,
        status,
        stream.received,
      );
      stream.watch = watch;
      const behind =
        !!status &&
        (status.broken || status.exitPending || status.sent > stream.received);
      const stuck = behind && stream.checkedAt === stream.received;
      stream.stalledSince = stuck ? (stream.stalledSince ?? now) : null;
      stream.checkedAt = stream.received;
      if (action === "reattach") void reattach(stream);
      else if (action === "gone") {
        console.warn("[anbo] terminal session ended unseen", stream.id);
        stream.finish(-1);
      }
    }
  } catch (cause) {
    console.warn("[anbo] terminal output check failed", cause);
  } finally {
    checking = false;
  }
}

type TauriInternals = { unregisterCallback?: (id: number) => void };

// A channel that lost a message holds every later one until its callback is
// dropped, and Channel offers no public way to drop it.
function forgetChannel(channel: Channel<ArrayBuffer>): void {
  const internals = (
    window as unknown as { __TAURI_INTERNALS__?: TauriInternals }
  ).__TAURI_INTERNALS__;
  internals?.unregisterCallback?.(channel.id);
}

async function reattach(stream: PtyStream): Promise<void> {
  if (stream.attaching) return;
  stream.attaching = true;
  const previous = stream.channel;
  stream.channel = stream.newChannel();
  // Messages the old channel still gets were only late, and the new one has
  // them again; none means one was lost. Round 64's soak could not tell: all
  // its reattaches came while a new browser host was starting.
  let late = 0;
  previous.onmessage = () => {
    late += 1;
  };
  console.warn(
    "[anbo] terminal output stalled; attaching a new channel",
    stream.id,
    stream.received,
  );
  try {
    const known = await withinTime(
      invoke<boolean>("pty_attach", {
        id: stream.id,
        onData: stream.channel,
        received: stream.received,
      }),
      WATCH_CALL_TIMEOUT_MS,
    );
    if (!known) stream.finish(-1);
  } catch (cause) {
    console.warn("[anbo] terminal output attach failed", stream.id, cause);
  } finally {
    // A failed attach is retried on a fresh channel at the next check.
    stream.attaching = false;
    setTimeout(() => {
      forgetChannel(previous);
      void warn(
        late > 0
          ? `terminal ${stream.id}: its replaced output channel still got ${late} messages, so they were late, not lost`
          : `terminal ${stream.id}: its replaced output channel got nothing more, so a message was lost`,
      ).catch(() => {});
    }, LATE_WINDOW_MS);
  }
}

/** Since when a PTY's output has been behind Rust's, while it is: the UI is
 *  asking for it again. */
export function ptyOutputStalledSince(ptyId: number): number | null {
  return watched.get(ptyId)?.stalledSince ?? null;
}

export async function openPty(
  cols: number,
  rows: number,
  handlers: PtyHandlers,
  cwd?: string,
  blocks?: boolean,
  shell?: string,
): Promise<PtySession> {
  // Raw bytes, no base64/JSON round-trip; messages arrive as ArrayBuffer.
  const stream = new PtyStream(handlers);

  const id = await invoke<number>("pty_open", {
    cols,
    rows,
    cwd: cwd ?? null,
    workspace: currentWorkspaceEnv(),
    blocks: blocks ?? false,
    shell: shell ?? null,
    onData: stream.channel,
  });
  stream.id = id;
  startWatching(stream);

  let closed = false;
  const headers = { "x-pty-id": String(id) };
  const resizeQueue = new LatestResizeQueue(({ cols: c, rows: r }) =>
    invoke("pty_resize", { id, cols: c, rows: r }),
  );
  const inputQueue = new PtyInputQueue(
    // Raw bytes + id header: no JSON round-trip on the per-keystroke path.
    (data) =>
      invoke(
        "pty_write",
        textEncoder.encode(IS_WINDOWS ? encodeWindowsPtyInput(data) : data),
        { headers },
      ),
    WRITE_ANSWER_LIMIT_MS,
  );

  return {
    id,
    write: (data) => inputQueue.write(data),
    resize: (c, r) => resizeQueue.request({ cols: c, rows: r }),
    close: async () => {
      if (closed) return;
      closed = true;
      resizeQueue.dispose();
      inputQueue.close(new Error("the terminal closed"));
      try {
        await invoke("pty_close", { id });
      } finally {
        stream.stop();
      }
    },
  };
}
