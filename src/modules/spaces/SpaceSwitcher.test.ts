import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, "SpaceSwitcher.tsx"), "utf8");

describe("SpaceSwitcher hover layout", () => {
  it("keeps a fixed action slot instead of swapping display modes", () => {
    expect(source).toContain("h-5 w-16 shrink-0");
    expect(source).not.toContain("group-hover:hidden");
    expect(source).not.toContain(
      "hidden shrink-0 items-center gap-0.5 group-hover:flex",
    );
  });
});
