import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renameEntry, trashEntry } from "./pathMutations";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const workspace = { kind: "local" } as const;
beforeEach(() => {
  vi.mocked(invoke).mockReset();
});

describe("guarded file mutations", () => {
  it.each([
    ["/repo/file.txt", "/repo/new.txt"],
    ["/repo/file.txt", "/repo/folder/file.txt"],
    ["/repo/folder", "/repo/other/folder"],
  ])("runs the guard before rename or move of %s", async (from, to) => {
    const after = vi.fn();
    await expect(
      renameEntry({
        from,
        to,
        workspace,
        after,
        before: () => {
          throw new Error("unsaved changes");
        },
      }),
    ).rejects.toThrow("unsaved changes");
    expect(invoke).not.toHaveBeenCalled();
    expect(after).not.toHaveBeenCalled();
  });

  it("updates document paths only after successful scoped IPC", async () => {
    const steps: string[] = [];
    vi.mocked(invoke).mockImplementation(async () => {
      steps.push("ipc");
    });
    const env = { kind: "wsl", distro: "Ubuntu" } as const;
    await renameEntry({
      from: "/repo/a",
      to: "/repo/b",
      workspace: env,
      before: () => {
        steps.push("guard");
      },
      after: () => {
        steps.push("update");
      },
    });
    expect(steps).toEqual(["guard", "ipc", "update"]);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("fs_rename", {
      from: "/repo/a",
      to: "/repo/b",
      workspace: env,
    });
  });

  it("propagates a failed move without retargeting tabs", async () => {
    vi.mocked(invoke).mockRejectedValue("already exists");
    const after = vi.fn();
    await expect(
      renameEntry({ from: "/repo/a", to: "/repo/b", workspace, after }),
    ).rejects.toBe("already exists");
    expect(after).not.toHaveBeenCalled();
  });

  it("uses trash, not permanent delete, and reports success once", async () => {
    const after = vi.fn();
    await trashEntry({ path: "/repo/file", workspace, after });
    expect(invoke).toHaveBeenCalledExactlyOnceWith("fs_trash", {
      path: "/repo/file",
      workspace,
    });
    expect(after).toHaveBeenCalledExactlyOnceWith("/repo/file");
  });

  it("does not dispatch trash for an unsaved file", async () => {
    await expect(
      trashEntry({
        path: "/repo/file",
        workspace,
        before: () => {
          throw new Error("save first");
        },
      }),
    ).rejects.toThrow("save first");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("does not fall back to permanent deletion or close tabs after a trash failure", async () => {
    vi.mocked(invoke).mockRejectedValue("unsupported location");
    const after = vi.fn();
    await expect(
      trashEntry({ path: "/repo/file", workspace, after }),
    ).rejects.toBe("unsupported location");
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(after).not.toHaveBeenCalled();
  });
});
