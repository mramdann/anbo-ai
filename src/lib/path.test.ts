import { describe, expect, it } from "vitest";
import { basename, lastPathPart, relativeDirname } from "./path";

describe("path helpers", () => {
  it("lastPathPart keeps what follows the last separator, even nothing", () => {
    expect(lastPathPart("D:\\work\\.env")).toBe(".env");
    expect(lastPathPart("/home/u/.ssh/")).toBe("");
    expect(lastPathPart("notes.md")).toBe("notes.md");
  });

  it("basename skips trailing separators and names a root", () => {
    expect(basename("/home/u/src/")).toBe("src");
    expect(basename("C:\\repo")).toBe("repo");
    expect(basename("/")).toBe("/");
    expect(basename("/", "root")).toBe("root");
    expect(basename("", "/")).toBe("/");
  });

  it("relativeDirname uses / and is empty at the top", () => {
    expect(relativeDirname("src\\lib\\path.ts")).toBe("src/lib");
    expect(relativeDirname("README.md")).toBe("");
  });
});
