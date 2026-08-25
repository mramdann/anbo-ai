import { describe, expect, it } from "vitest";
import { fileIconUrl, folderIconUrl } from "./iconResolver";

describe("Material explorer icon resolver", () => {
  it("resolves common file names and extensions to distinct Material icons", () => {
    const packageIcon = fileIconUrl("package.json");
    const typescriptIcon = fileIconUrl("index.ts");
    const unknownIcon = fileIconUrl("example.unknown-anbo-extension");

    expect(packageIcon).toMatch(/^data:image\/svg\+xml;utf8,/);
    expect(typescriptIcon).toMatch(/^data:image\/svg\+xml;utf8,/);
    expect(packageIcon).not.toBe(typescriptIcon);
    expect(typescriptIcon).not.toBe(unknownIcon);
  });

  it("preserves Iconify viewBox offsets for icons with negative coordinates", () => {
    const jsonIcon = decodeURIComponent(fileIconUrl("components.json"));

    expect(jsonIcon).toMatch(/viewBox="[^"]* -\d+ \d+ \d+"/);
  });

  it("resolves named folders and preserves closed and expanded variants", () => {
    const sourceClosed = folderIconUrl("src", false);
    const sourceOpen = folderIconUrl("src", true);
    const claudeFolder = folderIconUrl(".claude", false);
    const unknownFolder = folderIconUrl("unknown-anbo-folder", false);

    expect(sourceClosed).not.toBe(sourceOpen);
    expect(claudeFolder).not.toBe(unknownFolder);
    expect(unknownFolder).toMatch(/^data:image\/svg\+xml;utf8,/);
  });
});
