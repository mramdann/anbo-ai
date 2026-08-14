function normalizedId(id) {
  return id.replaceAll("\\", "/").split("?", 1)[0];
}

export function packageNameFromModuleId(id) {
  const normalized = normalizedId(id);
  const marker = "/node_modules/";
  const index = normalized.lastIndexOf(marker);
  if (index === -1) return null;
  const packagePath = normalized.slice(index + marker.length);
  const segments = packagePath.split("/");
  if (!segments[0]) return null;
  return segments[0].startsWith("@") && segments[1]
    ? `${segments[0]}/${segments[1]}`
    : segments[0];
}

export function bundleChunkName(id) {
  const normalized = normalizedId(id);
  if (
    normalized.includes("vite/preload-helper") ||
    normalized.includes("/vite/dist/")
  ) {
    return "react";
  }

  const packageName = packageNameFromModuleId(normalized);
  if (!packageName) return null;

  if (
    packageName === "clsx" ||
    packageName === "tailwind-merge" ||
    packageName === "class-variance-authority"
  ) {
    return "react";
  }
  if (
    packageName === "ai" ||
    packageName === "throttleit" ||
    packageName.startsWith("@ai-sdk/")
  ) {
    // Preserve provider lazy imports without forcing cyclic shared chunks.
    return null;
  }

  if (packageName === "xterm" || packageName.startsWith("@xterm/")) {
    return "xterm";
  }
  // Let Rolldown place Dockview to avoid a cyclic shared application chunk.
  if (packageName === "dockview" || packageName === "dockview-react") {
    return null;
  }

  if (
    packageName.startsWith("@codemirror/lang-") ||
    packageName === "@codemirror/legacy-modes" ||
    packageName === "@replit/codemirror-lang-svelte"
  ) {
    return null;
  }
  if (
    packageName === "codemirror" ||
    packageName.startsWith("@codemirror/") ||
    packageName.startsWith("@uiw/codemirror") ||
    packageName === "@uiw/react-codemirror" ||
    packageName === "@replit/codemirror-vim" ||
    packageName.startsWith("@lezer/")
  ) {
    // Keep one CodeMirror facet runtime; language implementations stay lazy.
    return "editor-runtime";
  }
  if (packageName === "streamdown" || packageName.startsWith("@streamdown/")) {
    return "streamdown";
  }
  if (
    packageName === "react" ||
    packageName === "react-dom" ||
    packageName === "scheduler"
  ) {
    return "react";
  }
  if (packageName === "radix-ui" || packageName.startsWith("@radix-ui/")) {
    return "radix";
  }
  return null;
}
