import type { Tab } from "./useTabs";

/**
 * The label shown on a tab. Non-terminal tabs use their stored title; terminal
 * tabs prefer a user-set custom name, then their stable agent callsign, then
 * the last segment of the cwd.
 */
export function labelFor(t: Tab): string {
  if (t.kind === "editor") return t.title;
  if (t.kind === "browser") return t.title;
  if (t.kind === "markdown") return t.title;
  if (t.kind === "ai-diff") return t.title;
  if (t.kind === "git-diff") return t.title;
  if (t.kind === "git-history") return t.title;
  if (t.kind === "git-commit-file") return t.title;
  if (t.customTitle) return t.customTitle;
  if (t.agent) return t.agent.name;
  if (!t.cwd) return t.title;
  const parts = t.cwd.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "/";
}
