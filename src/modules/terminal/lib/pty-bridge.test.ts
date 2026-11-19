import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const core = vi.hoisted(() => {
  const answers: Array<() => void> = [];
  // What Rust says of its streams when the watchdog asks.
  const statuses: unknown[] = [];
  const invoke = vi.fn((command: string, _payload?: unknown) => {
    if (command === "pty_open") return Promise.resolve(7);
    if (command === "pty_write") {
      return new Promise<void>((resolve) => {
        answers.push(resolve);
      });
    }
    if (command === "pty_output_status") return Promise.resolve([...statuses]);
    if (command === "pty_attach") return Promise.resolve(true);
    return Promise.resolve();
  });
  class Channel {
    id = 1;
    onmessage: (message: unknown) => void = () => {};
  }
  return { answers, statuses, invoke, Channel };
});

vi.mock("@tauri-apps/api/core", () => ({
  Channel: core.Channel,
  invoke: core.invoke,
}));
vi.mock("@tauri-apps/plugin-log", () => ({
  warn: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/lib/platform", () => ({ IS_WINDOWS: true }));
vi.mock("@/modules/workspace", () => ({ currentWorkspaceEnv: () => null }));

import { openPty } from "./pty-bridge";

function writesSent(): string[] {
  const decoder = new TextDecoder();
  return core.invoke.mock.calls
    .filter(([command]) => command === "pty_write")
    .map(([, bytes]) => decoder.decode(bytes as Uint8Array));
}

type Wire = { onmessage: (message: unknown) => void };

/** The channel the page handed to Rust with its last call of `command`. */
function channelOf(command: "pty_open" | "pty_attach"): Wire {
  const [call] = core.invoke.mock.calls
    .filter(([name]) => name === command)
    .slice(-1) as [string, { onData: Wire }][];
  return call[1].onData;
}

/** A data message as Rust frames it: kind 0, the offset, the bytes. */
const message = (offset: number, body: number[]) =>
  new Uint8Array([0, offset, 0, 0, 0, 0, 0, 0, 0, ...body]);

describe("openPty output", () => {
  beforeEach(() => {
    core.invoke.mockClear();
    core.statuses.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("delivers a message the same whether it came raw or as text", async () => {
    // Rust sends a short message as base64 text and a long one raw
    // (pty/output.rs); the terminal must not know the difference.
    const got: number[][] = [];
    const pty = await openPty(80, 24, {
      onData: (bytes) => got.push(Array.from(bytes)),
    });
    const channel = channelOf("pty_open");

    channel.onmessage(message(0, [104, 105]).buffer);
    channel.onmessage(
      btoa(String.fromCharCode(...message(2, [0x1b, 0xff, 10]))),
    );

    expect(got).toEqual([
      [104, 105],
      [0x1b, 0xff, 10],
    ]);
    await pty.close();
  });

  it("takes raw output that arrives as an array of numbers, and marks no gap", async () => {
    // Measured (round 114): with the page's IPC on its fallback path a
    // terminal printed 24 KB in one go. The raw message arrived as number[],
    // the reader threw on it, and the next short message made the terminal
    // show "[anbo: 26397 bytes of output were lost]".
    const decoder = new TextDecoder();
    const got: string[] = [];
    const pty = await openPty(80, 24, {
      onData: (bytes) => got.push(decoder.decode(bytes)),
    });
    const channel = channelOf("pty_open");

    channel.onmessage(Array.from(message(0, [104, 105])));
    channel.onmessage(btoa(String.fromCharCode(...message(2, [33]))));

    expect(got).toEqual(["hi", "!"]);
    await pty.close();
  });

  it("tells Rust what each stream holds, and takes what a replaced channel still delivers", async () => {
    // Measured (round 113): a page in which one terminal's raw messages were
    // held for 40 s asked for a new channel, threw away what the old one
    // then delivered, and asked Rust for output Rust had let go 30 s after
    // sending it: "[anbo: N bytes of output were lost]". Rust now keeps
    // output until the page names it in its check, and a message that was
    // only late is taken wherever it arrives.
    vi.useFakeTimers();
    vi.stubGlobal("window", {});
    const got: number[][] = [];
    const pty = await openPty(80, 24, {
      onData: (bytes) => got.push(Array.from(bytes)),
    });
    const first = channelOf("pty_open");
    first.onmessage(message(0, [1, 2]).buffer);
    // Rust has handed over five bytes; two have arrived.
    core.statuses.push({
      id: 7,
      sent: 5,
      end: 5,
      broken: false,
      exitPending: false,
    });

    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(2_000);

    const checks = core.invoke.mock.calls.filter(
      ([command]) => command === "pty_output_status",
    );
    expect(checks).toHaveLength(2);
    expect(checks[1][1]).toEqual({ received: [[7, 2]] });
    const second = channelOf("pty_attach");
    expect(second).not.toBe(first);
    expect(
      core.invoke.mock.calls
        .filter(([name]) => name === "pty_attach")
        .slice(-1)[0]?.[1],
    ).toMatchObject({ id: 7, received: 2 });

    // The message the first channel was slow with arrives after all.
    first.onmessage(message(2, [3, 4, 5]).buffer);
    // Rust sends the same again on the new channel, and then goes on.
    second.onmessage(message(2, [3, 4, 5]).buffer);
    second.onmessage(btoa(String.fromCharCode(...message(5, [6]))));

    expect(got).toEqual([[1, 2], [3, 4, 5], [6]]);
    await pty.close();
  });
});

describe("openPty input", () => {
  beforeEach(() => {
    core.answers.length = 0;
    core.invoke.mockClear();
  });

  it("keeps one write of a terminal in flight, in the order typed", async () => {
    const pty = await openPty(80, 24, { onData: () => {} });
    const typed = [pty.write("g"), pty.write("i"), pty.write("t")];
    const enter = pty.write("\r");

    expect(writesSent()).toEqual(["g"]);
    core.answers[0]();
    await typed[0];
    await vi.waitFor(() => expect(writesSent()).toEqual(["g", "it"]));
    core.answers[1]();
    await vi.waitFor(() => expect(writesSent()).toEqual(["g", "it", "\r"]));
    core.answers[2]();

    await expect(Promise.all([...typed, enter])).resolves.toBeDefined();
    await pty.close();
  });

  it("encodes what it joined for Windows when it sends it", async () => {
    const pty = await openPty(80, 24, { onData: () => {} });
    const held = pty.write("x");
    const joined = [pty.write("a"), pty.write("é")];

    core.answers[0]();
    await held;
    await vi.waitFor(() => expect(writesSent()).toHaveLength(2));

    expect(writesSent()[1]).toBe("a\x1b[0;0;233;1;0;1_\x1b[0;0;233;0;0;1_");
    core.answers[1]();
    await Promise.all(joined);
    await pty.close();
  });

  it("refuses input still waiting when the terminal closes", async () => {
    const pty = await openPty(80, 24, { onData: () => {} });
    const out = pty.write("a");
    const waiting = pty.write("b");

    await pty.close();

    await expect(waiting).rejects.toThrow("the terminal closed");
    expect(writesSent()).toEqual(["a"]);
    core.answers[0]();
    await out;
  });

  it("does not hold one terminal's input behind another's", async () => {
    const first = await openPty(80, 24, { onData: () => {} });
    const second = await openPty(80, 24, { onData: () => {} });

    void first.write("a");
    void second.write("b");

    expect(writesSent()).toEqual(["a", "b"]);
    core.answers[0]();
    core.answers[1]();
    await first.close();
    await second.close();
  });
});
