import type { Theme, ThemeColors, ThemeMode } from "./types";

export const STARTUP_THEME_KEY = "anbo-startup-theme-shadow";
const COLOR_KEYS = [
  "background",
  "foreground",
  "mutedForeground",
  "primary",
  "border",
  "accent",
  "destructive",
] as const satisfies readonly (keyof ThemeColors)[];

export function startupThemeSnapshot(theme: Theme) {
  const palette = (mode: ThemeMode) => {
    const variant =
      theme.variants[mode] ?? theme.variants.dark ?? theme.variants.light;
    const colors: Partial<Record<(typeof COLOR_KEYS)[number], string>> = {};
    for (const key of COLOR_KEYS) {
      const value = variant?.colors?.[key];
      if (typeof value === "string" && value.length > 0 && value.length <= 128)
        colors[key] = value;
    }
    return colors;
  };
  return {
    version: 1,
    themeId: theme.id,
    light: palette("light"),
    dark: palette("dark"),
  };
}

export function rememberStartupTheme(
  theme: Theme,
  selectedId: string,
  previewId: string | null,
): void {
  if (
    typeof window === "undefined" ||
    previewId !== null ||
    theme.id !== selectedId ||
    theme.id.length > 128
  )
    return;
  try {
    const snapshot = JSON.stringify(startupThemeSnapshot(theme));
    if (window.localStorage.getItem(STARTUP_THEME_KEY) !== snapshot)
      window.localStorage.setItem(STARTUP_THEME_KEY, snapshot);
  } catch {
    // Startup uses neutral colors when storage is unavailable.
  }
}
