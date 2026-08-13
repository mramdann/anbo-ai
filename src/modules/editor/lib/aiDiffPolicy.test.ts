import { describe, expect, it } from "vitest";
import { AI_DIFF_RENDER_MAX_BYTES, aiDiffRenderPolicy } from "./aiDiffPolicy";

describe("aiDiffRenderPolicy", () => {
  it("renders normal diffs immediately", () => {
    expect(aiDiffRenderPolicy("old", "new").deferred).toBe(false);
  });

  it("defers byte-heavy diffs", () => {
    const result = aiDiffRenderPolicy(
      "x".repeat(AI_DIFF_RENDER_MAX_BYTES),
      "new",
    );
    expect(result.deferred).toBe(true);
  });

  it("defers line-heavy diffs", () => {
    expect(aiDiffRenderPolicy("a\n".repeat(20_001), "new").deferred).toBe(
      true,
    );
  });
});
