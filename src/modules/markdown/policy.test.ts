import { describe, expect, it } from "vitest";
import {
  boundLargeMarkdownFences,
  MARKDOWN_FENCE_MAX_BYTES,
} from "./policy";

describe("boundLargeMarkdownFences", () => {
  it("leaves ordinary markdown unchanged", () => {
    const markdown = "# Title\n\n```ts\nconst ok = true;\n```\n";
    expect(boundLargeMarkdownFences(markdown)).toEqual({
      content: markdown,
      truncatedFences: 0,
    });
  });

  it("bounds a large fence while keeping surrounding content", () => {
    const markdown = `before\n\n\`\`\`txt\n${"x".repeat(MARKDOWN_FENCE_MAX_BYTES + 100)}\n\`\`\`\nafter`;
    const result = boundLargeMarkdownFences(markdown);
    expect(result.truncatedFences).toBe(1);
    expect(result.content).toContain("before");
    expect(result.content).toContain("Anbo omitted");
    expect(result.content).toContain("```\nafter");
  });

  it("supports tilde fences", () => {
    const markdown = `~~~txt\n${"a\n".repeat(1_300)}~~~\n`;
    expect(boundLargeMarkdownFences(markdown).truncatedFences).toBe(1);
  });
});
