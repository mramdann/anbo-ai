import { describe, expect, it } from "vitest";
import { workspaceSourceControlPath } from "./useSourceControlContext";

describe("workspaceSourceControlPath", () => {
  it("uses the active space root instead of a terminal working directory", () => {
    expect(workspaceSourceControlPath("C:/Documents/notaris")).toBe(
      "C:/Documents/notaris",
    );
  });

  it("does not inherit a cwd for an unconfigured space", () => {
    expect(workspaceSourceControlPath(null)).toBeNull();
  });
});
