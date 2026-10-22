import { describe, expect, it } from "vitest";
import {
  freshWatch,
  lostOutputNotice,
  parsePtyMessage,
  type PtyOutputStatus,
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

  it("calls a session gone once Rust has not known it twice", () => {
    const first = watchStream(freshWatch(), undefined, 10);
    expect(first.action).toBe("none");
    expect(watchStream(first.watch, undefined, 10).action).toBe("gone");
    expect(watchStream(first.watch, status(), 10).action).toBe("none");
  });
});
