import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, "SpaceSwitcher.tsx"), "utf8");

describe("SpaceSwitcher hover layout", () => {
  it("keeps a fixed action slot instead of swapping display modes", () => {
    expect(source).toContain("h-6 w-[4.5rem] shrink-0");
    expect(source).not.toContain("group-hover:hidden");
    expect(source).not.toContain(
      "hidden shrink-0 items-center gap-0.5 group-hover:flex",
    );
  });

  it("scales the switcher and drag overlay with the application UI zoom", () => {
    expect(source.match(/\[zoom:var\(--app-zoom\)\]/g)).toHaveLength(2);
  });

  it("shows the active space avatar in the switcher trigger", () => {
    expect(source).toContain(
      '<SpaceAvatar space={current} size="sm" active />',
    );
  });
});
