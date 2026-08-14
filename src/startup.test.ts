import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const html = readFileSync(path.resolve("index.html"), "utf8");
const entry = readFileSync(path.resolve("src/main.tsx"), "utf8");

describe("startup surface", () => {
  it("renders status content before the React bundle loads", () => {
    expect(html).toContain('id="anbo-startup"');
    expect(html).toContain('role="status"');
    expect(html).toContain("Preparing your workspace");
    expect(html).toContain("anbo-startup-slide");
    expect(html).toContain('id="anbo-startup-error"');
    expect(html).toContain('window.addEventListener("error"');
    expect(html).toContain('window.addEventListener("unhandledrejection"');
    expect(html).toContain('window.addEventListener("anbo:startup-error"');
  });

  it("keeps React render failures visible instead of leaving a blank window", () => {
    expect(entry).toContain("class RootErrorBoundary");
    expect(entry).toContain("Anbo could not open this workspace");
    expect(entry).toContain('data-testid="root-error-detail"');
  });
});
