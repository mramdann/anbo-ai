import { describe, expect, it } from "vitest";
import { buildDesignTheme, sanitizeDesignThemeValue } from "./designTheme";

describe("design theme handoff", () => {
  it("maps app tokens onto the chrome and keeps only colour text", () => {
    const tokens: Record<string, string> = {
      "--popover": " oklch(0.218 0.008 223.9) ",
      "--popover-foreground": "#e4f2f5",
      "--muted-foreground": "hsl(210 10% 60%)",
      "--border": "oklch(1 0 0 / 10%)",
      "--input": "red; background: url(x)",
      "--primary": "",
      "--primary-foreground": "x".repeat(65),
    };
    expect(buildDesignTheme("dark", (token) => tokens[token] ?? "")).toEqual({
      mode: "dark",
      surface: "oklch(0.218 0.008 223.9)",
      text: "#e4f2f5",
      muted: "hsl(210 10% 60%)",
      border: "oklch(1 0 0 / 10%)",
    });
    expect(buildDesignTheme("light", () => "")).toEqual({ mode: "light" });
  });

  it("refuses anything that could end a declaration or fetch a resource", () => {
    expect(sanitizeDesignThemeValue("#fff")).toBe("#fff");
    expect(sanitizeDesignThemeValue("rgb(1, 2, 3)")).toBe("rgb(1, 2, 3)");
    expect(sanitizeDesignThemeValue("color-mix(in oklch, red, blue)")).toBe(
      "color-mix(in oklch, red, blue)",
    );
    for (const bad of [
      "a}",
      "b;",
      "url(x)",
      "image(x)",
      "var(--x)",
      "<svg>",
      "'x'",
      "",
    ]) {
      expect(sanitizeDesignThemeValue(bad)).toBeNull();
    }
  });
});
