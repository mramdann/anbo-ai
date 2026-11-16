import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, "SpaceSwitcher.tsx"), "utf8");

describe("SpaceSwitcher hover layout", () => {
  it("keeps a fixed action slot instead of swapping display modes", () => {
    // Three actions (rename, new tab, delete) share one slot of a fixed width.
    expect(source).toContain(
      'className="relative flex h-6 w-[4.5rem] shrink-0 items-center justify-end"',
    );
    expect(source).not.toContain("w-[6.5rem]");
    expect(source).not.toContain("group-hover:hidden");
    expect(source).not.toContain(
      "hidden shrink-0 items-center gap-0.5 group-hover:flex",
    );
  });

  it("leaves pausing, resuming and usage numbers to the usage view", () => {
    expect(source).not.toContain("Pause space");
    expect(source).not.toContain("Resume space");
    expect(source).not.toContain("formatMemory");
    // A paused space still carries its mark.
    expect(source).toContain('aria-label="Paused"');
  });

  it("scales the switcher and drag overlay with the application UI zoom", () => {
    expect(source.match(/\[zoom:var\(--app-zoom\)\]/g)).toHaveLength(2);
  });

  it("shows the active space avatar in the switcher trigger", () => {
    expect(source).toContain(
      '<SpaceAvatar space={current} size="sm" active />',
    );
  });

  it("changes expanded spaces only from the disclosure button", () => {
    expect(source).toContain("useState<Set<string>>(() => new Set())");
    expect(source).toContain("onToggle={() => toggleExpand(sp.id)}");
    expect(source).not.toContain("new Set(prev).add(activeId)");
  });
});
