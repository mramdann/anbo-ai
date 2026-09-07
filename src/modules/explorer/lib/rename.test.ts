import { describe, expect, it } from "vitest";
import {
  assertRenameHasNoUnsavedEditors,
  renameSelectionEnd,
  renameTarget,
  renamedDocumentPatch,
} from "./rename";

describe("explorer rename target", () => {
  it.each([
    ["/repo/file.ts", "new.ts", "/repo/new.ts"],
    ["/repo/folder", "new.folder", "/repo/new.folder"],
    ["D:\\repo\\file.ts", "new.ts", "D:/repo/new.ts"],
    ["D:/file.ts", "new.ts", "D:/new.ts"],
    ["/file.ts", "new.ts", "/new.ts"],
    ["//server/share/file.ts", "new.ts", "//server/share/new.ts"],
    ["/repo/file", "rencana baru.txt", "/repo/rencana baru.txt"],
    ["/repo/file", "日本語.txt", "/repo/日本語.txt"],
    ["/repo/file", ".gitignore", "/repo/.gitignore"],
  ])("keeps %s in its parent", (from, name, expected) => {
    expect(renameTarget(from, name)).toBe(expected);
  });

  it("does not dispatch an unchanged name", () => {
    expect(renameTarget("D:/repo/file.ts", "file.ts")).toBeNull();
  });

  it.each(["", "  ", ".", "..", "../outside", "a/b", "a\\b", "a\0b", "a\nb"])(
    "rejects invalid name %j",
    (name) => {
      expect(() => renameTarget("/repo/file.ts", name)).toThrow();
    },
  );

  it.each([
    "CON",
    "nul.txt",
    "COM1.log",
    "LPT9",
    "bad?",
    "x:y",
    "name.",
    "name ",
  ])("rejects invalid Windows name %j", (name) => {
    expect(() => renameTarget("D:/repo/file.ts", name)).toThrow();
  });

  it("keeps POSIX names separate from Windows restrictions", () => {
    expect(renameTarget("/repo/file.ts", "report:today")).toBe(
      "/repo/report:today",
    );
    expect(renameTarget("/repo/file.ts", "CON")).toBe("/repo/CON");
  });
});

describe("renamed document tabs", () => {
  it.each(["editor", "markdown"])(
    "updates a %s file and nested document",
    (kind) => {
      expect(
        renamedDocumentPatch(
          { kind, path: "/repo/readme.md" },
          "/repo/readme.md",
          "/repo/guide.md",
        ),
      ).toEqual({ path: "/repo/guide.md", title: "guide.md" });
      expect(
        renamedDocumentPatch(
          { kind, path: "/repo/docs/intro/readme.md" },
          "/repo/docs",
          "/repo/guides",
        ),
      ).toEqual({ path: "/repo/guides/intro/readme.md", title: "readme.md" });
    },
  );
  it("matches Windows case and separators while retaining the new case", () => {
    expect(
      renamedDocumentPatch(
        { kind: "markdown", path: "d:\\REPO\\Docs\\README.md" },
        "D:/repo/docs",
        "D:/repo/Guides",
      ),
    ).toEqual({ path: "D:/repo/Guides/README.md", title: "README.md" });
  });
  it("does not retarget historical diffs, other folders or case-sensitive siblings", () => {
    for (const tab of [
      { kind: "git-commit-file", path: "/repo/docs/a.md" },
      { kind: "ai-diff", path: "/repo/docs/a.md" },
      { kind: "markdown", path: "/repo/docs-other/a.md" },
      { kind: "markdown", path: "/repo/DOCS/a.md" },
      { kind: "terminal" },
    ])
      expect(renamedDocumentPatch(tab, "/repo/docs", "/repo/new")).toBeNull();
  });
});

describe("rename selection", () => {
  it("selects the file stem without changing its extension", () => {
    expect(renameSelectionEnd("report.test.ts", false)).toBe(11);
  });
  it("selects complete dotted folder names and dotfiles", () => {
    expect(renameSelectionEnd("folder.v2", true)).toBe(9);
    expect(renameSelectionEnd(".gitignore", false)).toBe(10);
    expect(renameSelectionEnd("README", false)).toBe(6);
  });
});

describe("rename unsaved editor guard", () => {
  const dirty = (path: string) => ({ kind: "editor", path, dirty: true });
  it("blocks renaming a dirty file or its parent folder", () => {
    expect(() =>
      assertRenameHasNoUnsavedEditors("/repo/a.ts", [dirty("/repo/a.ts")]),
    ).toThrow("Save unsaved changes");
    expect(() =>
      assertRenameHasNoUnsavedEditors("/repo/src", [dirty("/repo/src/a.ts")]),
    ).toThrow("Save unsaved changes");
  });
  it("matches Windows separators and case", () => {
    expect(() =>
      assertRenameHasNoUnsavedEditors("D:\\repo\\src", [
        dirty("d:/REPO/src/a.ts"),
      ]),
    ).toThrow();
  });
  it("does not block clean documents, prefix siblings or other tab kinds", () => {
    expect(() =>
      assertRenameHasNoUnsavedEditors("/repo/src", [
        { kind: "editor", path: "/repo/src/a.ts", dirty: false },
        dirty("/repo/src-other/a.ts"),
        dirty("/repo/SRC/a.ts"),
        { kind: "terminal", path: "/repo/src", dirty: true },
      ]),
    ).not.toThrow();
  });
});
