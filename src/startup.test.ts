import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const html = readFileSync(path.resolve("index.html"), "utf8");
const entry = readFileSync(path.resolve("src/main.tsx"), "utf8");
const startupRoot = readFileSync(
  path.resolve("src/app/StartupRoot.tsx"),
  "utf8",
);

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
    expect(html).toContain('window.addEventListener("anbo:startup-progress"');
    expect(html).toContain('window.addEventListener("anbo:startup-ready"');
    expect(html).toContain("Startup stopped while");
    expect(html).toContain("application module did not finish loading");
  });

  it("keeps React render failures visible instead of leaving a blank window", () => {
    expect(entry).toContain("function reportStartupProgress");
    expect(entry).toContain("<RootErrorBoundary>");
    expect(entry).toContain("<StartupReady>");
    expect(startupRoot).toContain("export class RootErrorBoundary");
    expect(startupRoot).toContain("export function StartupReady");
    expect(startupRoot).toContain('new CustomEvent("anbo:startup-ready")');
    expect(startupRoot).toContain("Anbo could not open this workspace");
    expect(startupRoot).toContain('data-testid="root-error-detail"');
  });

  it("defines no components in the entry, so Dev reloads instead of running it twice", () => {
    const component =
      /^\s*(?:export\s+(?:default\s+)?)?(?:(?:async\s+)?function|class|const|let)\s+[A-Z][a-z0-9]\w*/m;
    expect(entry).not.toMatch(component);
  });
});
