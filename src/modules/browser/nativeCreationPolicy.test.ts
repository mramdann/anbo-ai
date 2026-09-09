import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("native browser creation focus policy", () => {
  it("never asks a new browser child to take OS focus", () => {
    const source = readFileSync(
      "src-tauri/src/modules/browser/embed.rs",
      "utf8",
    );
    const creation = source.slice(
      source.indexOf("let builder = WebviewBuilder::new("),
      source.indexOf(".on_navigation("),
    );
    expect(creation).toContain(".focused(false)");
    expect(creation).not.toContain(".focused(true)");
  });
});
