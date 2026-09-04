/**
 * Finding the URL under a click, without xterm's link layer.
 *
 * A full-screen program that asks for mouse reporting takes the mouse away
 * from the terminal: xterm hands the events straight to the application and
 * only restores its own handling while Shift is held. Agent CLIs are exactly
 * that kind of program, so links printed by an agent look like links and do
 * nothing when clicked. Reading the URL out of the buffer ourselves sidesteps
 * that entirely.
 */

// Deliberately narrower than a permissive URL matcher: only what a browser tab
// can open, so nothing else is ever handed to it by mistake.
const URL_PATTERN = /https?:\/\/[^\s<>"'`{}|\\^[\]]+/g;

/**
 * Trailing characters that end a sentence rather than a URL. A closing round
 * bracket is judged separately: Wikipedia paths really do end in one.
 */
const TRAILING = /[.,;:!?\]}>'"]+$/;

export function trimUrlPunctuation(url: string): string {
  let trimmed = url.replace(TRAILING, "");
  // Drop a closing bracket only while nothing in the URL opened it, and check
  // the balance before each cut rather than after stripping them all.
  while (trimmed.endsWith(")")) {
    const opens = (trimmed.match(/\(/g) ?? []).length;
    const closes = (trimmed.match(/\)/g) ?? []).length;
    if (closes <= opens) break;
    trimmed = trimmed.slice(0, -1).replace(TRAILING, "");
  }
  return trimmed;
}

/**
 * The URL covering `column` in `line`, or null when the click landed on
 * ordinary text. Columns are zero-based, matching the terminal buffer.
 */
export function findUrlAt(line: string, column: number): string | null {
  if (!line || column < 0) return null;
  URL_PATTERN.lastIndex = 0;
  for (const match of line.matchAll(URL_PATTERN)) {
    const start = match.index ?? 0;
    const raw = match[0];
    const url = trimUrlPunctuation(raw);
    if (!url) continue;
    if (column >= start && column < start + url.length) return url;
  }
  return null;
}
