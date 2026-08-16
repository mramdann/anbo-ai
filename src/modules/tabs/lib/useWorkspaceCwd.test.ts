import { describe, expect, it } from "vitest";
import { resolveWorkspacePaths } from "./useWorkspaceCwd";

describe("resolveWorkspacePaths", () => {
  it("keeps the configured space root when a terminal changes directory", () => {
    expect(resolveWorkspacePaths("C:/Documents/notaris")).toEqual({
      explorerRoot: "C:/Documents/notaris",
      newTabCwd: "C:/Documents/notaris",
    });
  });

  it("switches immediately to the newly active space root", () => {
    expect(resolveWorkspacePaths("C:/Documents/anbo-ai").explorerRoot).toBe(
      "C:/Documents/anbo-ai",
    );
  });

  it("keeps a new unconfigured space free of inherited cwd", () => {
    expect(resolveWorkspacePaths(null)).toEqual({
      explorerRoot: null,
      newTabCwd: undefined,
    });
  });
});
