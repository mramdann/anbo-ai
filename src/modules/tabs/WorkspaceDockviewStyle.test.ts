import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const css = readFileSync(path.join(here, "WorkspaceDockview.css"), "utf8");

describe("WorkspaceDockview active tab highlight", () => {
  it("uses theme tokens for a smooth active-group pulse", () => {
    expect(css).toContain("@keyframes anbo-workspace-active-tab-pulse");
    expect(css).toContain("var(--primary)");
    expect(css).toContain("var(--ring)");
    expect(css).toContain(".dv-groupview.dv-active-group");
  });

  it("disables the repeating pulse for reduced motion", () => {
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain("animation: none");
  });
});
