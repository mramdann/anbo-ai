import { IS_WINDOWS } from "./platform";

// PowerShell ends a quoted string at the curly forms of the quote too.
const POWERSHELL_QUOTES = new RegExp(
  `['${String.fromCodePoint(0x2018, 0x2019, 0x201a, 0x201b)}]`,
  "g",
);

export function quoteShellArg(value: string, windows = IS_WINDOWS): string {
  if (windows) {
    return `'${value.replace(POWERSHELL_QUOTES, "$&$&")}'`;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}
