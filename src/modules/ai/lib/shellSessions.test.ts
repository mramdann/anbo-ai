import { beforeEach, describe, expect, it, vi } from "vitest";

const nativeMock = vi.hoisted(() => ({
  shellSessionOpen: vi.fn(),
  shellSessionClose: vi.fn(async () => undefined),
}));

vi.mock("./native", () => ({ native: nativeMock }));

import {
  getPersistentShell,
  releaseShellSessionsForChat,
} from "./shellSessions";

const workspace = { kind: "local" } as const;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AI shell session lifecycle", () => {
  it("reuses one shell for the same scoped chat", async () => {
    nativeMock.shellSessionOpen.mockResolvedValue(41);
    await expect(
      getPersistentShell("chat-a:scope", null, workspace),
    ).resolves.toBe(41);
    await expect(
      getPersistentShell("chat-a:scope", null, workspace),
    ).resolves.toBe(41);
    expect(nativeMock.shellSessionOpen).toHaveBeenCalledTimes(1);

    releaseShellSessionsForChat("chat-a");
    await vi.waitFor(() =>
      expect(nativeMock.shellSessionClose).toHaveBeenCalledWith(41),
    );
  });

  it("removes a rejected open so a later call can retry", async () => {
    nativeMock.shellSessionOpen
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce(42);

    await expect(
      getPersistentShell("chat-b:scope", null, workspace),
    ).rejects.toThrow("temporary failure");
    await expect(
      getPersistentShell("chat-b:scope", null, workspace),
    ).resolves.toBe(42);
    expect(nativeMock.shellSessionOpen).toHaveBeenCalledTimes(2);

    releaseShellSessionsForChat("chat-b");
  });
});
