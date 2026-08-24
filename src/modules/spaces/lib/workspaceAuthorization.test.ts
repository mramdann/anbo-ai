import { describe, expect, it, vi } from "vitest";
import { authorizeWorkspaceRoot } from "./workspaceAuthorization";

describe("authorizeWorkspaceRoot", () => {
  it("commits only after native authorization returns the canonical root", async () => {
    let resolveAuthorization: ((root: string) => void) | undefined;
    const authorize = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveAuthorization = resolve;
        }),
    );
    const commit = vi.fn();

    const pending = authorizeWorkspaceRoot({
      path: "D:/RAMDAN/QIKB/NTT/KUPANG/source",
      workspace: { kind: "local" },
      authorize,
      commit,
    });

    expect(authorize).toHaveBeenCalledWith("D:/RAMDAN/QIKB/NTT/KUPANG/source", {
      kind: "local",
    });
    expect(commit).not.toHaveBeenCalled();

    resolveAuthorization?.("D:/RAMDAN/QIKB/NTT/KUPANG/source");
    await expect(pending).resolves.toBe("D:/RAMDAN/QIKB/NTT/KUPANG/source");
    expect(commit).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledWith("D:/RAMDAN/QIKB/NTT/KUPANG/source");
  });

  it("preserves the current UI state when authorization fails", async () => {
    const commit = vi.fn();

    await expect(
      authorizeWorkspaceRoot({
        path: "D:/outside",
        workspace: { kind: "local" },
        authorize: vi.fn().mockRejectedValue(new Error("not authorized")),
        commit,
      }),
    ).rejects.toThrow("not authorized");

    expect(commit).not.toHaveBeenCalled();
  });
});
