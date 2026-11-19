import { describe, expect, it, vi } from "vitest";

const core = vi.hoisted(() => {
  class Channel {
    onmessage: (message: unknown) => void = () => {};
  }
  const invoke = vi.fn((_command: string, _payload?: unknown) =>
    Promise.resolve(3),
  );
  return { Channel, invoke };
});

vi.mock("@tauri-apps/api/core", () => ({
  Channel: core.Channel,
  invoke: core.invoke,
}));
vi.mock("@tauri-apps/plugin-log", () => ({
  warn: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/modules/workspace", () => ({ currentWorkspaceEnv: () => null }));

import { TauriLspTransport } from "./transport";

type Wire = { onmessage: (message: unknown) => void };

describe("TauriLspTransport", () => {
  it("reads a server's message whether its bytes came as a buffer or as numbers", async () => {
    // Once one request of the page has failed, Tauri's IPC hands raw bytes
    // over as an array of numbers (`ipcBytes`). A TextDecoder refuses that,
    // so a server's message of 1 KB or more was dropped.
    const transport = new TauriLspTransport();
    await transport.start({ command: "server", args: [], root: "C:/work" });
    const [, payload] = core.invoke.mock.calls[0] as [
      string,
      { onMessage: Wire },
    ];
    const got: string[] = [];
    transport.onMessage((text) => got.push(text));
    const bytes = new TextEncoder().encode('{"jsonrpc":"2.0","result":"é"}');
    expect(() =>
      new TextDecoder().decode(Array.from(bytes) as never),
    ).toThrow();

    payload.onMessage.onmessage(bytes.buffer);
    payload.onMessage.onmessage(Array.from(bytes));

    expect(got).toEqual([
      '{"jsonrpc":"2.0","result":"é"}',
      '{"jsonrpc":"2.0","result":"é"}',
    ]);
  });
});
