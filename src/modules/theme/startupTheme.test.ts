import { afterEach, describe, expect, it, vi } from "vitest";
import {
  rememberStartupTheme,
  STARTUP_THEME_KEY,
  startupThemeSnapshot,
} from "./startupTheme";
import { getDefaultTheme, listBuiltinThemes } from "./themes";
import { claude } from "./themes/claude";
import type { Theme } from "./types";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("startup theme palette", () => {
  it.each(listBuiltinThemes())(
    "keeps both $id variants in a bounded cache",
    (theme) => {
      const snapshot = startupThemeSnapshot(theme);
      expect(snapshot.themeId).toBe(theme.id);
      expect(snapshot.version).toBe(1);
      expect(JSON.stringify(snapshot).length).toBeLessThan(4096);
      for (const mode of ["light", "dark"] as const) {
        const variant =
          theme.variants[mode] ?? theme.variants.dark ?? theme.variants.light;
        expect(snapshot[mode].background).toBe(variant?.colors?.background);
        expect(snapshot[mode].primary).toBe(variant?.colors?.primary);
        expect(Object.keys(snapshot[mode]).length).toBeLessThanOrEqual(7);
        expect(snapshot[mode]).not.toHaveProperty("terminal");
        expect(snapshot[mode]).not.toHaveProperty("radius");
      }
    },
  );

  it("falls back like applyTheme for a custom single-variant theme", () => {
    const theme: Theme = {
      id: "custom",
      name: "Custom",
      variants: {
        dark: { colors: { background: "#123456", primary: "#abcdef" } },
      },
    };
    const snapshot = startupThemeSnapshot(theme);
    expect(snapshot.light).toEqual(snapshot.dark);
    expect(snapshot.dark).toEqual({
      background: "#123456",
      primary: "#abcdef",
    });
  });

  it("keeps partial and default variants on CSS fallbacks", () => {
    expect(startupThemeSnapshot(getDefaultTheme()).dark).toEqual({});
    expect(
      startupThemeSnapshot({
        id: "partial",
        name: "Partial",
        variants: {
          light: {
            colors: { primary: "#112233", foreground: "x".repeat(129) },
          },
        },
      }).light,
    ).toEqual({ primary: "#112233" });
  });

  it("writes committed palettes only when they change", () => {
    const values = new Map<string, string>();
    const setItem = vi.fn((key: string, value: string) => {
      values.set(key, value);
    });
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem,
      },
    });
    rememberStartupTheme(claude, "claude", null);
    rememberStartupTheme(claude, "claude", null);
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(JSON.parse(values.get(STARTUP_THEME_KEY) ?? "null")).toEqual(
      startupThemeSnapshot(claude),
    );
    rememberStartupTheme(getDefaultTheme(), "anbo-default", null);
    expect(setItem).toHaveBeenCalledTimes(2);
  });

  it("does not overwrite the committed theme with a preview or a loading custom-theme fallback", () => {
    const setItem = vi.fn();
    vi.stubGlobal("window", { localStorage: { getItem: () => null, setItem } });
    rememberStartupTheme(claude, "claude", "claude");
    rememberStartupTheme(claude, "custom-still-loading", null);
    rememberStartupTheme(getDefaultTheme(), "custom-still-loading", null);
    expect(setItem).not.toHaveBeenCalled();
  });

  it("ignores unavailable or full storage without failing theme application", () => {
    const denied = () => {
      throw new Error("storage denied");
    };
    vi.stubGlobal("window", { localStorage: { getItem: denied } });
    expect(() => rememberStartupTheme(claude, "claude", null)).not.toThrow();
    vi.stubGlobal("window", {
      localStorage: { getItem: () => null, setItem: denied },
    });
    expect(() => rememberStartupTheme(claude, "claude", null)).not.toThrow();
  });
});
