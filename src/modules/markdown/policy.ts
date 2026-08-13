export const MARKDOWN_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;
export const MARKDOWN_FENCE_MAX_BYTES = 64 * 1024;
export const MARKDOWN_FENCE_MAX_LINES = 1_200;

export type BoundedMarkdown = {
  content: string;
  truncatedFences: number;
};

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (byteLength(value) <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (byteLength(value.slice(0, middle)) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return value.slice(0, low);
}

export function boundLargeMarkdownFences(markdown: string): BoundedMarkdown {
  const lines = markdown.match(/.*(?:\r\n|\n|$)/g)?.filter(Boolean) ?? [];
  const output: string[] = [];
  let truncatedFences = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const opening = lines[index].match(/^\s*(`{3,}|~{3,})([^\r\n]*)/);
    if (!opening) {
      output.push(lines[index]);
      continue;
    }
    const marker = opening[1];
    const markerChar = marker[0];
    const closingPattern = new RegExp(
      `^\\s*${markerChar}{${marker.length},}\\s*(?:\\r?\\n)?$`,
    );
    let closingIndex = index + 1;
    while (
      closingIndex < lines.length &&
      !closingPattern.test(lines[closingIndex])
    ) {
      closingIndex += 1;
    }
    if (closingIndex >= lines.length) {
      output.push(lines[index]);
      continue;
    }
    const bodyLines = lines.slice(index + 1, closingIndex);
    const body = bodyLines.join("");
    output.push(lines[index]);
    if (
      bodyLines.length > MARKDOWN_FENCE_MAX_LINES ||
      byteLength(body) > MARKDOWN_FENCE_MAX_BYTES
    ) {
      const preview = truncateUtf8(body, MARKDOWN_FENCE_MAX_BYTES);
      output.push(preview);
      if (!preview.endsWith("\n")) output.push("\n");
      output.push(
        `[Anbo omitted ${Math.max(0, byteLength(body) - byteLength(preview))} bytes from this preview. Use Raw to view the full fence.]\n`,
      );
      truncatedFences += 1;
    } else {
      output.push(body);
    }
    output.push(lines[closingIndex]);
    index = closingIndex;
  }
  return { content: output.join(""), truncatedFences };
}
