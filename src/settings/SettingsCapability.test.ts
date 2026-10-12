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

  it("can hide itself while a theme file opens in the main window's editor", () => {
    // Themes' New theme and Edit call getCurrentWindow().hide(); refused, the
    // window stayed over the editor it had just opened the file in.
    const capability = JSON.parse(
      readFileSync(
        path.resolve("src-tauri/capabilities/settings.json"),
        "utf8",
      ),
    ) as { permissions: string[] };

    expect(capability.permissions).toContain("core:window:allow-hide");
  });
});
