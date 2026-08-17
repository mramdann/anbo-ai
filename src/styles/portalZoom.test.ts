import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const css = readFileSync(path.join(here, "globals.css"), "utf8");

describe("portal UI zoom", () => {
  it.each([
    "alert-dialog-content",
    "context-menu-content",
    "dropdown-menu-content",
    "popover-content",
    "select-content",
    "tooltip-content",
  ])("keeps %s on the application UI zoom", (slot) => {
    expect(css).toContain(`[data-slot="${slot}"]`);
  });

  it("uses the shared zoom token", () => {
    expect(css).toContain("zoom: var(--app-zoom)");
  });
});
