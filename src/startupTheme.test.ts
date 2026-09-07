import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { startupThemeSnapshot } from "@/modules/theme/startupTheme";
import { claude } from "@/modules/theme/themes/claude";

const html = readFileSync("index.html", "utf8");
const script =
  html.match(/<script data-anbo-startup-theme>([\s\S]*?)<\/script>/)?.[1] ?? "";
if (!script) throw new Error("Missing inline startup theme script");

function boot({
  mode = "system",
  dark = true,
  themeId = "claude",
  raw = JSON.stringify(startupThemeSnapshot(claude)),
  blocked = false,
} = {}) {
  const classes: string[] = [];
  const properties = new Map<string, string>();
  const style = {
    backgroundColor: "",
    colorScheme: "",
    setProperty: (key: string, value: string) => {
      properties.set(key, value);
    },
  };
  const values: Record<string, string> = {
    "anbo-ui-theme-shadow": mode,
    "anbo-ui-theme-id-shadow": themeId,
    "anbo-startup-theme-shadow": raw,
  };
  runInNewContext(
    script,
    {
      window: { matchMedia: () => ({ matches: dark }) },
      localStorage: {
        getItem: (key: string) => {
          if (blocked) throw new Error("denied");
          return values[key] ?? null;
        },
      },
      document: {
        documentElement: {
          classList: {
            add: (value: string) => {
              classes.push(value);
            },
          },
          style,
        },
      },
      CSS: {
        supports: (_property: string, value: string) =>
          /^(#[\da-f]{3,8}|rgba?\([\d,.\s]+\))$/i.test(value),
      },
    },
    { timeout: 1000 },
  );
  return { classes, properties, style };
}

describe("pre-bundle startup theme", () => {
  it.each(["dark", "light"])(
    "uses cached %s colors before modules or IPC are available",
    (mode) => {
      const result = boot({ mode, dark: mode !== "dark" });
      const colors = claude.variants[mode as "dark" | "light"]?.colors;
      expect(result.classes).toEqual([mode]);
      expect(result.style.colorScheme).toBe(mode);
      expect(result.style.backgroundColor).toBe("var(--startup-bg)");
      expect(result.properties.get("--startup-bg")).toBe(colors?.background);
      expect(result.properties.get("--startup-accent")).toBe(colors?.primary);
      expect(result.properties.get("--startup-muted")).toBe(
        colors?.mutedForeground,
      );
    },
  );

  it.each([true, false])(
    "resolves system mode at boot, system dark=%s",
    (dark) => {
      const result = boot({ dark });
      expect(result.properties.get("--startup-bg")).toBe(
        claude.variants[dark ? "dark" : "light"]?.colors?.background,
      );
    },
  );

  it.each([
    "",
    "{broken",
    "null",
    "[]",
    "x".repeat(4097),
    JSON.stringify({ version: 2, themeId: "claude", dark: {} }),
    JSON.stringify({
      version: 1,
      themeId: "other",
      dark: { background: "#ff0000" },
    }),
  ])("falls back safely for an absent, invalid or stale cache", (raw) => {
    const result = boot({ raw });
    expect(result.properties.size).toBe(0);
    expect(result.classes).toEqual(["dark"]);
  });

  it("still follows the system when storage is blocked", () => {
    expect(boot({ blocked: true, dark: false }).classes).toEqual(["light"]);
    expect(boot({ blocked: true }).properties.size).toBe(0);
  });

  it.each([
    "url(https://example.invalid/a)",
    "var(--missing)",
    "currentColor",
    "inherit",
    "initial",
    "unset",
    "revert",
    "red; background: url(x)",
    "x".repeat(129),
  ])("does not restore unsafe or unresolved color %s", (background) => {
    const raw = JSON.stringify({
      version: 1,
      themeId: "claude",
      dark: { background, primary: "#aabbcc", unexpected: "#ffffff" },
    });
    const result = boot({ raw });
    expect([...result.properties]).toEqual([["--startup-accent", "#aabbcc"]]);
  });

  it("keeps default splash tokens aligned with the app's base theme", () => {
    const css = readFileSync("src/styles/globals.css", "utf8");
    const keys = {
      bg: "background",
      fg: "foreground",
      muted: "muted-foreground",
      accent: "primary",
      line: "border",
      hover: "accent",
      danger: "destructive",
    };
    for (const mode of ["light", "dark"]) {
      const splash =
        html.match(
          mode === "light"
            ? /:root\.light\s*\{([^}]+)\}/
            : /:root\s*\{([^}]+)\}/,
        )?.[1] ?? "";
      const app =
        css.match(
          mode === "light" ? /:root\s*\{([^}]+)\}/ : /\.dark\s*\{([^}]+)\}/,
        )?.[1] ?? "";
      for (const [name, token] of Object.entries(keys)) {
        const value = splash.match(
          new RegExp(`--startup-${name}:\\s*([^;]+);`),
        )?.[1];
        expect(value).toBe(
          app.match(new RegExp(`--${token}:\\s*([^;]+);`))?.[1],
        );
        expect(value).toBeTruthy();
      }
    }
  });
});
