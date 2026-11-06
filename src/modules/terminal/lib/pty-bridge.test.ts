import { beforeEach, describe, expect, it, vi } from "vitest";

const core = vi.hoisted(() => {
  const answers: Array<() => void> = [];
  const invoke = vi.fn((command: string, _payload?: unknown) => {
    if (command === "pty_open") return Promise.resolve(7);
    if (command === "pty_write") {
      return new Promise<void>((resolve) => {
        answers.push(resolve);
      });
    }
    return Promise.resolve();
  });
  class Channel {
    id = 1;
    onmessage: (message: unknown) => void = () => {};
  }
  return { answers, invoke, Channel };
});

vi.mock("@tauri-apps/api/core", () => ({
  Channel: core.Channel,
  invoke: core.invoke,
}));
vi.mock("@tauri-apps/plugin-log", () => ({ warn: vi.fn() }));
vi.mock("@/lib/platform", () => ({ IS_WINDOWS: true }));
vi.mock("@/modules/workspace", () => ({ currentWorkspaceEnv: () => null }));

import { openPty } from "./pty-bridge";

function writesSent(): string[] {
  const decoder = new TextDecoder();
  return core.invoke.mock.calls
    .filter(([command]) => command === "pty_write")
    .map(([, bytes]) => decoder.decode(bytes as Uint8Array));
}

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
