export function renameTarget(path: string, name: string): string | null {
  const normalized = path.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  if (name === normalized.slice(slash + 1)) return null;
  if (!name.trim()) throw new Error("Enter a file or folder name.");
  if (
    name === "." ||
    name === ".." ||
    /[\\/]/.test(name) ||
    [...name].some((char) => char.charCodeAt(0) < 32)
  ) {
    throw new Error(
      "Enter a name, not a path. Slashes and control characters are not allowed.",
    );
  }
  const windowsPath =
    /^[A-Za-z]:\//.test(normalized) || normalized.startsWith("//");
  if (windowsPath && /[<>:"|?*]|[. ]$/.test(name)) {
    throw new Error(
      'Windows names cannot contain < > : " | ? * or end with a dot or space.',
    );
  }
  if (
    windowsPath &&
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
  ) {
    throw new Error("This name is reserved by Windows. Choose another name.");
  }
  return `${normalized.slice(0, slash + 1)}${name}`;
}

export function renameSelectionEnd(name: string, isDirectory: boolean): number {
  const dot = name.lastIndexOf(".");
  return !isDirectory && dot > 0 ? dot : name.length;
}

export function assertRenameHasNoUnsavedEditors(
  path: string,
  tabs: readonly { kind: string; path?: string; dirty?: boolean }[],
  operation = "renaming",
): void {
  const windowsPath = /^[A-Za-z]:[\\/]/.test(path) || /^[\\/]{2}/.test(path);
  const normalize = (value: string) => {
    const normalized = value.replace(/\\/g, "/");
    return windowsPath ? normalized.toLowerCase() : normalized;
  };
  const from = normalize(path);
  const affected = tabs.some((tab) => {
    if (tab.kind !== "editor" || !tab.dirty || !tab.path) return false;
    const candidate = normalize(tab.path);
    return candidate === from || candidate.startsWith(`${from}/`);
  });
  if (affected) {
    throw new Error(
      `Save unsaved changes in this file or folder before ${operation} it.`,
    );
  }
}

export function renamedDocumentPatch(
  tab: { kind: string; path?: string },
  from: string,
  to: string,
): { path: string; title: string } | null {
  if ((tab.kind !== "editor" && tab.kind !== "markdown") || !tab.path)
    return null;
  const windowsPath = /^[A-Za-z]:[\\/]/.test(from) || /^[\\/]{2}/.test(from);
  const source = from.replace(/\\/g, "/");
  const current = tab.path.replace(/\\/g, "/");
  const sourceKey = windowsPath ? source.toLowerCase() : source;
  const currentKey = windowsPath ? current.toLowerCase() : current;
  if (currentKey !== sourceKey && !currentKey.startsWith(`${sourceKey}/`))
    return null;
  const path = to.replace(/\\/g, "/") + current.slice(source.length);
  return { path, title: path.slice(path.lastIndexOf("/") + 1) };
}
