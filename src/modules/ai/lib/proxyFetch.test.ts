import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  channels: [] as Array<{ onmessage: (event: unknown) => void }>,
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage = (_event: unknown) => {};

    constructor() {
      mocks.channels.push(this);
    }
  },
  invoke: mocks.invoke,
}));

import { proxyFetch } from "./proxyFetch";

describe("proxyFetch cancellation", () => {
  beforeEach(() => {
    mocks.channels.length = 0;
    mocks.invoke.mockReset();
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "ai_http_stream") return new Promise(() => {});
      return Promise.resolve();
    });
  });

  it("cancels backend HTTP work when the fetch signal aborts", async () => {
    const controller = new AbortController();
    const response = proxyFetch("https://example.com", {
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(mocks.channels).toHaveLength(1));
    const streamCall = mocks.invoke.mock.calls.find(
      ([command]) => command === "ai_http_stream",
    );
    expect(streamCall).toBeDefined();

    controller.abort();

    await expect(response).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.invoke).toHaveBeenCalledWith("ai_http_cancel", {
      requestId: streamCall?.[1].requestId,
    });
  });
});
