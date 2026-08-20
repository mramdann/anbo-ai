import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("settings window capability", () => {
  it("can reveal the window after the frontend is ready", () => {
    const capability = JSON.parse(
      readFileSync(
        path.resolve("src-tauri/capabilities/settings.json"),
        "utf8",
      ),
    ) as { windows: string[]; permissions: string[] };

    expect(capability.windows).toContain("settings");
    expect(capability.permissions).toContain("core:window:allow-show");
  });
});
