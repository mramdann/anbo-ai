import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { materialIconUrls } from "./materialIconSet";
import { fileIconUrl, folderIconUrl } from "./iconResolver";

describe("Material explorer icon resolver", () => {
  it("resolves common file names and extensions to distinct Material icons", () => {
    const packageIcon = fileIconUrl("package.json");
    const typescriptIcon = fileIconUrl("index.ts");
    const unknownIcon = fileIconUrl("example.unknown-anbo-extension");

    expect(packageIcon).toMatch(
      /^\/material-icons\/[a-z0-9-]+\.svg\?v=[a-f0-9]+$/,
    );
    expect(typescriptIcon).toMatch(/^\/material-icons\//);
    expect(packageIcon).not.toBe(typescriptIcon);
    expect(typescriptIcon).not.toBe(unknownIcon);
  });

  it("preserves Iconify viewBox offsets for icons with negative coordinates", () => {
    const jsonIcon = readFileSync(
      `public${fileIconUrl("components.json").split("?")[0]}`,
      "utf8",
    );

    expect(jsonIcon).toMatch(/viewBox="[^"]* -\d+ \d+ \d+"/);
  });

  it("resolves named folders and preserves closed and expanded variants", () => {
    const sourceClosed = folderIconUrl("src", false);
    const sourceOpen = folderIconUrl("src", true);
    const claudeFolder = folderIconUrl(".claude", false);
    const unknownFolder = folderIconUrl("unknown-anbo-folder", false);

    expect(sourceClosed).not.toBe(sourceOpen);
    expect(claudeFolder).not.toBe(unknownFolder);
    expect(unknownFolder).toMatch(/^\/material-icons\//);
  });
  it("ships every referenced asset with its content revision", () => {
    for (const url of Object.values(materialIconUrls)) {
      const [path, query] = url.split("?");
      const svg = readFileSync(`public${path}`, "utf8");
      expect(svg).toMatch(/^<svg /);
      expect(query).toBe(
        `v=${createHash("sha256").update(svg).digest("hex").slice(0, 12)}`,
      );
      expect(svg).not.toMatch(
        /<script|onload=|https?:\/\/(?!www.w3.org\/2000\/svg)/i,
      );
    }
  });
  it("keeps prototype-like names on safe local fallback assets", () => {
    expect(fileIconUrl("constructor")).toMatch(/^\/material-icons\//);
    expect(folderIconUrl("__proto__", false)).toMatch(/^\/material-icons\//);
  });
});
