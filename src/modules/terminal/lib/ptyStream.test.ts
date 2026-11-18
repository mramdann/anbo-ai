import { describe, expect, it } from "vitest";
import {
  freshWatch,
  lostOutputNotice,
  parsePtyMessage,
  type PtyOutputStatus,
  ptyMessageBuffer,
  unseenPart,
  watchStream,
} from "./ptyStream";

function frame(kind: number, header: number[], body: number[] = []) {
  return new Uint8Array([kind, ...header, ...body]).buffer;
}

const status = (overrides: Partial<PtyOutputStatus> = {}): PtyOutputStatus => ({
  id: 4,
  sent: 10,
  end: 10,
  broken: false,
  exitPending: false,
  ...overrides,
});

describe("PTY stream messages", () => {
  it("reads data with its offset and the exit code", () => {
    const data = parsePtyMessage(
      frame(0, [0x02, 0x01, 0, 0, 0, 0, 0, 0], [104, 105]),
    );
    expect(data).toMatchObject({ kind: "data", offset: 0x0102 });
    expect(data?.kind === "data" && Array.from(data.bytes)).toEqual([104, 105]);
    expect(parsePtyMessage(frame(1, [0xff, 0xff, 0xff, 0xff]))).toEqual({
      kind: "exit",
      code: -1,
    });
    expect(parsePtyMessage(new Uint8Array([7, 1]).buffer)).toBeNull();
  });

  it("reads a message sent as text like the same message sent raw", () => {
    // Rust sends a short message as base64 text, which Tauri evaluates in
    // place; a raw body of 1 KB or more is fetched by a request of its own,
    // and that cost more than the output itself (round 112). The bytes are
    // ones no text encoding keeps: an escape, a NUL, half a character, 0xff.
    const body = [0x1b, 0x5b, 0, 0xe2, 0x94, 0xff, 0x0a];
    const raw = frame(0, [9, 0, 0, 0, 0, 0, 0, 0], body);
    const text = btoa(String.fromCharCode(...new Uint8Array(raw)));
    expect(ptyMessageBuffer(raw)).toBe(raw);
    const read = parsePtyMessage(ptyMessageBuffer(text));
    expect(read).toMatchObject({ kind: "data", offset: 9 });
    expect(read?.kind === "data" && Array.from(read.bytes)).toEqual(body);
    expect(
      parsePtyMessage(
        ptyMessageBuffer(btoa(String.fromCharCode(1, 3, 0, 0, 0))),
      ),
    ).toEqual({ kind: "exit", code: 3 });
  });

  it("keeps only what a message sent again adds, and counts a gap", () => {
    const bytes = new TextEncoder().encode("hello");
    expect(unseenPart(0, 0, bytes)).toMatchObject({ lost: 0, received: 5 });
    const overlap = unseenPart(3, 0, bytes);
    expect(new TextDecoder().decode(overlap.part ?? undefined)).toBe("lo");
    expect(overlap.received).toBe(5);
    expect(unseenPart(5, 0, bytes)).toEqual({
      part: null,
      lost: 0,
      received: 5,
    });
    expect(unseenPart(2, 9, bytes)).toMatchObject({ lost: 7, received: 14 });
    expect(lostOutputNotice(7)).toContain("7 bytes of output were lost");
  });
});

describe("PTY stream watchdog", () => {
  it("gives a stream a new channel at once when its send failed", () => {
    expect(watchStream(freshWatch(), status({ broken: true }), 10).action).toBe(
      "reattach",
    );
  });

  it("gives a stream a new channel when it stays behind for a whole check", () => {
    // Measured (round 61): the UI's channel waited forever for one lost
    // message; the terminal froze while its shell ran on.
    const first = watchStream(freshWatch(), status({ sent: 30 }), 10);
    expect(first.action).toBe("none");
    expect(watchStream(first.watch, status({ sent: 30 }), 10).action).toBe(
      "reattach",
    );
  });

  it("leaves a stream that is behind but moving", () => {
    const first = watchStream(freshWatch(), status({ sent: 30 }), 10);
    const second = watchStream(first.watch, status({ sent: 60 }), 30);
    expect(second.action).toBe("none");
    expect(watchStream(second.watch, status({ sent: 60 }), 60).action).toBe(
      "none",
    );
  });

  it("asks again for an exit code that does not arrive", () => {
    const first = watchStream(freshWatch(), status({ exitPending: true }), 10);
    expect(first.action).toBe("none");
    expect(
      watchStream(first.watch, status({ exitPending: true }), 10).action,
    ).toBe("reattach");
  });

  it("waits twice as long each time it asked and nothing came, and is quick again once the stream moves", () => {
    // A new channel makes Rust send everything again. A page too busy to
    // take its output is not helped by that: round 113's stalled terminal
    // asked 14 times in a minute. The checks are 2 s apart: it asks after 4 s,
    // then 8 s later, 16 s, and at most every 32 s.
    const behind = status({ sent: 30 });
    let watch = freshWatch();
    const asks: number[] = [];
    for (let check = 1; check <= 70; check += 1) {
      const next = watchStream(watch, behind, 10);
      watch = next.watch;
      if (next.action === "reattach") asks.push(check);
    }
    expect(asks).toEqual([2, 6, 14, 30, 46, 62]);

    // One message arrives: the next stall is met as quickly as the first.
    const moved = watchStream(watch, behind, 20);
    expect(moved.action).toBe("none");
    expect(watchStream(moved.watch, behind, 20).action).toBe("reattach");
  });

  it("calls a session gone once Rust has not known it twice", () => {
    const first = watchStream(freshWatch(), undefined, 10);
    expect(first.action).toBe("none");
    expect(watchStream(first.watch, undefined, 10).action).toBe("gone");
    expect(watchStream(first.watch, status(), 10).action).toBe("none");
  });
});
