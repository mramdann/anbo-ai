import type { BrowserDesignTheme } from "@/modules/browser/native";

/** Which app tokens paint which part of the in-page chrome. */
const TOKEN_SOURCES: Record<
  Exclude<keyof BrowserDesignTheme, "mode">,
  string
> = {
  surface: "--popover",
  text: "--popover-foreground",
  muted: "--muted-foreground",
  border: "--border",
  field: "--input",
  accent: "--primary",
  accentText: "--primary-foreground",
};

// A colour travels into a page as a CSS custom property value; this is the
// whole alphabet a colour function needs and nothing that could end a
// declaration or open a block, and the only functions allowed are colour
// functions, so a theme cannot make the page fetch a url. Rust checks the
// same shape again.
const SAFE_VALUE = /^[A-Za-z0-9#(),.%/ -]{1,64}$/;
const FUNCTION_NAMES = /([a-z-]*)\(/gi;
const COLOR_FUNCTIONS = new Set([
  "rgb",
  "rgba",
  "hsl",
  "hsla",
  "hwb",
  "lab",
  "lch",
  "oklab",
  "oklch",
  "color",
  "color-mix",
  "light-dark",
]);

export function sanitizeDesignThemeValue(value: string): string | null {
  const trimmed = value.trim();
  if (!SAFE_VALUE.test(trimmed)) return null;
  for (const match of trimmed.matchAll(FUNCTION_NAMES)) {
    if (!COLOR_FUNCTIONS.has(match[1].toLowerCase())) return null;
  }
  return trimmed;
}

export function buildDesignTheme(
  mode: "light" | "dark",
  read: (token: string) => string,
): BrowserDesignTheme {
  const theme: BrowserDesignTheme = { mode };
  for (const [key, token] of Object.entries(TOKEN_SOURCES)) {
    const value = sanitizeDesignThemeValue(read(token) ?? "");
    if (value) theme[key as keyof typeof TOKEN_SOURCES] = value;
  }
  return theme;
}

export function readDesignTheme(mode: "light" | "dark"): BrowserDesignTheme {
  if (typeof document === "undefined") return { mode };
  const style = getComputedStyle(document.documentElement);
  return buildDesignTheme(mode, (token) => style.getPropertyValue(token));
}
