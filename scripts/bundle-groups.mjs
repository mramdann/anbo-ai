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

function legacyModeName(id) {
  const match = normalizedId(id).match(
    /\/node_modules\/@codemirror\/legacy-modes\/mode\/([\w-]+)/,
  );
  return match ? `cm-legacy-${match[1]}` : null;
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
  if (packageName === "@ai-sdk/anthropic") return "ai-anthropic";
  if (packageName === "@ai-sdk/google") return "ai-google";
  if (packageName === "@ai-sdk/openai-compatible") {
    return "ai-openai-compat";
  }
  if (packageName === "@ai-sdk/openai") return "ai-openai";
  if (packageName === "@ai-sdk/cerebras") return "ai-cerebras";
  if (packageName === "@ai-sdk/groq") return "ai-groq";
  if (packageName === "@ai-sdk/xai") return "ai-xai";
  if (packageName.startsWith("@ai-sdk/")) return "ai-sdk-shared";

  if (packageName === "xterm" || packageName.startsWith("@xterm/")) {
    return "xterm";
  }
  // Keep Dockview in the graph chosen by Rolldown. Forcing dockview and
  // dockview-react into a named chunk can create a production-only cycle with
  // shared application chunks (dockview -> shared app chunk -> dockview), so a
  // base class is still undefined when the chunk is evaluated.
  if (packageName === "dockview" || packageName === "dockview-react") {
    return null;
  }

  const language = packageName.match(/^@codemirror\/lang-([\w-]+)$/);
  if (language) return `cm-lang-${language[1]}`;
  if (packageName === "@codemirror/legacy-modes") {
    return legacyModeName(normalized) ?? "codemirror";
  }
  if (packageName === "@replit/codemirror-lang-svelte") {
    return "cm-lang-svelte";
  }
  if (
    packageName.startsWith("@codemirror/") ||
    packageName.startsWith("@uiw/codemirror") ||
    packageName === "@replit/codemirror-vim"
  ) {
    return "codemirror";
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
