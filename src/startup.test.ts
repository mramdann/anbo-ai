import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const html = readFileSync(path.resolve("index.html"), "utf8");

describe("startup surface", () => {
  it("renders status content before the React bundle loads", () => {
    expect(html).toContain('id="anbo-startup"');
    expect(html).toContain('role="status"');
    expect(html).toContain("Preparing your workspace");
    expect(html).toContain("anbo-startup-slide");
  });
});
