export type TerminalBufferRow = {
  text: string;
  wrapped: boolean;
};

export function joinTerminalBufferRows(
  rows: readonly TerminalBufferRow[],
  maxLines: number,
): string {
  const lines: string[] = [];
  for (const row of rows) {
    if (row.wrapped && lines.length > 0) lines[lines.length - 1] += row.text;
    else lines.push(row.text);
  }
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  if (lines.length > maxLines) lines.splice(0, lines.length - maxLines);
  return lines.join("\n");
}

const ANSI_RE =
  /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][AB012]|\x1b[78=>]|\x1bc|\x1b[NOP\]X^_]/g;

/** `text` without the escape sequences a terminal acts on. */
function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

/**
 * The text of a terminal that has no live buffer: what its buffer held when it
 * was let go (`snapshot`), and then the output that came since (`since`), as
 * the buffer it gets back replays them.
 *
 * The output since was left out whenever a snapshot was there. A hidden
 * terminal lets its buffer go 300 ms after it turns idle, so one at its prompt
 * read for ever as it stood then: the line an agent had cleared with Ctrl+C
 * was still at the prompt for every `terminal_read` (round 102, R102-2).
 */
export function releasedTerminalText(
  snapshot: string | null,
  since: string,
  maxLines: number,
): string {
  const source = (snapshot ?? "") + since;
  if (!source) return "";
  const lines = stripAnsi(source).split(/\r?\n/);
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  if (lines.length > maxLines) lines.splice(0, lines.length - maxLines);
  return lines.join("\n");
}
