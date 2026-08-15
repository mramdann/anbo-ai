import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(
  path.join(here, "useEditorWindowPresentation.ts"),
  "utf8",
);

describe("editor window presentation", () => {
  it("remeasures CodeMirror before restored content is revealed", () => {
    expect(source).toContain("subscribeWindowPresentation");
    expect(source).toContain("requestMeasure()");
  });
});
