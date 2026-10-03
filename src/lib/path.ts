/** The text after the last `/` or `\`, which is empty for a path ending in one. */
export function lastPathPart(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i >= 0 ? path.slice(i + 1) : path;
}

/**
 * The last segment of a path that is not empty: "src" for both "a/src" and
 * "a/src/". A path with no segment (a root, or "") gives `whenRoot`.
 */
export function basename(path: string, whenRoot = path): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : whenRoot;
}

/** The folder of a repository-relative path with `/` separators; "" at the top. */
export function relativeDirname(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  if (index <= 0) return "";
  return normalized.slice(0, index);
}
