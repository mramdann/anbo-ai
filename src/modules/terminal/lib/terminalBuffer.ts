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
