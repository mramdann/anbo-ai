export const AI_DIFF_RENDER_MAX_BYTES = 1024 * 1024;
export const AI_DIFF_RENDER_MAX_LINES = 20_000;

export type AiDiffRenderPolicy = {
  deferred: boolean;
  totalBytes: number;
  totalLines: number;
};

export function aiDiffRenderPolicy(
  original: string,
  proposed: string,
): AiDiffRenderPolicy {
  const encoder = new TextEncoder();
  const totalBytes =
    encoder.encode(original).byteLength + encoder.encode(proposed).byteLength;
  const totalLines = countLines(original) + countLines(proposed);
  return {
    deferred:
      totalBytes > AI_DIFF_RENDER_MAX_BYTES ||
      totalLines > AI_DIFF_RENDER_MAX_LINES,
    totalBytes,
    totalLines,
  };
}

function countLines(value: string): number {
  if (!value) return 0;
  let count = 1;
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) === 10) count += 1;
  }
  return count;
}
