import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PtyInputQueue } from "./ptyInputQueue";

const LIMIT_MS = 5_000;

type Sent = {
  data: string;
  answer: () => void;
  refuse: (cause: unknown) => void;
};

function queueWithManualAnswers() {
  const sent: Sent[] = [];
  const queue = new PtyInputQueue(
    (data) =>
      new Promise<void>((answer, refuse) => {
        sent.push({ data, answer, refuse });
      }),
    LIMIT_MS,
  );
  return { queue, sent };
}

async function settled(promise: Promise<void>): Promise<string> {
  try {
    await promise;
    return "answered";
  } catch (cause) {
    return String(cause);
  }
}

// Lets promise callbacks run without moving the fake clock.
const flush = () => vi.advanceTimersByTimeAsync(0);

describe("PtyInputQueue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends in the caller's tick when nothing is out", () => {
    const { queue, sent } = queueWithManualAnswers();
    void queue.write("a");
    expect(sent.map((item) => item.data)).toEqual(["a"]);
  });

  it("keeps a write back until the one before it was answered", async () => {
    const { queue, sent } = queueWithManualAnswers();
    const first = queue.write("\r");
    const second = queue.write("\x03");
    expect(sent.map((item) => item.data)).toEqual(["\r"]);

    sent[0].answer();
    await first;
    await flush();
    expect(sent.map((item) => item.data)).toEqual(["\r", "\x03"]);

    sent[1].answer();
    await second;
  });

  it("joins plain text waiting for its turn and answers each caller", async () => {
    const { queue, sent } = queueWithManualAnswers();
    const writes = ["a", "b", "c", "é"].map((key) => queue.write(key));

    sent[0].answer();
    await flush();
    expect(sent.map((item) => item.data)).toEqual(["a", "bcé"]);

    sent[1].answer();
    await expect(Promise.all(writes)).resolves.toBeDefined();
  });

  it("leaves a key that means something alone, in order", async () => {
    const { queue, sent } = queueWithManualAnswers();
    const keys = [
      "a",
      "b",
      "c",
      "\r",
      "d",
      "e",
      "\x1b",
      "f",
      "\x03",
      "\x7f",
      "\x1b[A",
      "\t",
      "\x1b[200~pasted\x1b[201~",
      "g",
    ];
    const writes = keys.map((key) => queue.write(key));

    for (let index = 0; index < 12; index += 1) {
      sent[index]?.answer();
      await flush();
    }
    await Promise.all(writes);

    expect(sent.map((item) => item.data)).toEqual([
      "a",
      "bc",
      "\r",
      "de",
      "\x1b",
      "f",
      "\x03",
      "\x7f",
      "\x1b[A",
      "\t",
      "\x1b[200~pasted\x1b[201~",
      "g",
    ]);
  });

  it("does not join across a key that stands alone", async () => {
    const { queue, sent } = queueWithManualAnswers();
    void queue.write("first");
    void queue.write("a");
    void queue.write("\r");
    void queue.write("b");

    sent[0].answer();
    await flush();
    sent[1].answer();
    await flush();
    sent[2].answer();
    await flush();

    expect(sent.map((item) => item.data)).toEqual(["first", "a", "\r", "b"]);
  });

  it("sends the next write after a refused one, and refuses only its own", async () => {
    const { queue, sent } = queueWithManualAnswers();
    const refused = queue.write("\r");
    const next = queue.write("\x03");

    sent[0].refuse("no session");
    expect(await settled(refused)).toBe("no session");
    await flush();
    sent[1].answer();
    expect(await settled(next)).toBe("answered");
  });

  it("refuses every caller of a joined write", async () => {
    const { queue, sent } = queueWithManualAnswers();
    void queue.write("a");
    const joined = [queue.write("b"), queue.write("c")];

    sent[0].answer();
    await flush();
    sent[1].refuse("no session");

    expect(await Promise.all(joined.map(settled))).toEqual([
      "no session",
      "no session",
    ]);
  });

  it("moves on when an answer never comes", async () => {
    const { queue, sent } = queueWithManualAnswers();
    const lost = queue.write("\r");
    const next = queue.write("\x03");

    await vi.advanceTimersByTimeAsync(LIMIT_MS - 1);
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent.map((item) => item.data)).toEqual(["\r", "\x03"]);

    sent[1].answer();
    await next;
    // The first write's caller still hears its real answer, not the limit.
    let heard = false;
    void lost.then(() => {
      heard = true;
    });
    await flush();
    expect(heard).toBe(false);
    sent[0].answer();
    await lost;
  });

  it("keeps the turn with the newest write when a late answer arrives", async () => {
    const { queue, sent } = queueWithManualAnswers();
    void queue.write("\r");
    void queue.write("\x03");
    void queue.write("\x7f");

    await vi.advanceTimersByTimeAsync(LIMIT_MS);
    expect(sent).toHaveLength(2);

    sent[0].answer();
    await flush();
    expect(sent).toHaveLength(2);

    sent[1].answer();
    await flush();
    expect(sent.map((item) => item.data)).toEqual(["\r", "\x03", "\x7f"]);
    sent[2].answer();
  });

  it("is free again once the limit passed with nothing waiting", async () => {
    const { queue, sent } = queueWithManualAnswers();
    void queue.write("a");
    await vi.advanceTimersByTimeAsync(LIMIT_MS);
    void queue.write("b");
    expect(sent.map((item) => item.data)).toEqual(["a", "b"]);
  });

  it("refuses what waits when the terminal closes and what comes later", async () => {
    const { queue, sent } = queueWithManualAnswers();
    const out = queue.write("a");
    const waiting = queue.write("b");

    queue.close(new Error("closed"));
    expect(await settled(waiting)).toBe("Error: closed");
    expect(await settled(queue.write("c"))).toBe("Error: closed");

    sent[0].answer();
    expect(await settled(out)).toBe("answered");
    await flush();
    expect(sent).toHaveLength(1);
  });

  it("survives a send that throws", async () => {
    let calls = 0;
    const queue = new PtyInputQueue((data) => {
      calls += 1;
      if (calls === 1) throw new Error(`bad ${data}`);
      return Promise.resolve();
    }, LIMIT_MS);

    expect(await settled(queue.write("a"))).toBe("Error: bad a");
    expect(await settled(queue.write("b"))).toBe("answered");
  });
});
