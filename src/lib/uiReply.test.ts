import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

const { replyToAnbo } = await import("./uiReply");

beforeEach(() => {
  invoke.mockReset();
});

describe("replyToAnbo", () => {
  it("hands the answer to the request it belongs to", async () => {
    invoke.mockResolvedValue(true);
    const response = { result: { ok: true } };
    await expect(replyToAnbo("4242-7", response)).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledWith("ui_reply", {
      requestId: "4242-7",
      response,
    });
  });

  it("says when Anbo had stopped waiting", async () => {
    invoke.mockResolvedValue(false);
    await expect(replyToAnbo("4242-8", { error: "late" })).resolves.toBe(false);
  });

  it("never rejects, so an answer that cannot be sent leaves nothing unhandled", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    invoke.mockRejectedValue(new Error("ipc down"));
    await expect(replyToAnbo("4242-9", {})).resolves.toBe(false);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});
