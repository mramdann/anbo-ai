/**
 * The words on an empty workspace.
 *
 * Kept apart from the component so they can be read as copy and tested as
 * functions: the greeting follows the clock, the line beneath the name is
 * drawn from a small pool by workspace and day — steady while you look at it,
 * different tomorrow — and knows how many agents it is talking about.
 */

/** The line at the top, by the hour on the clock (0–23). */
export function greetingFor(hour: number): string {
  if (hour >= 5 && hour < 12) return "Good morning";
  if (hour >= 12 && hour < 17) return "Good afternoon";
  if (hour >= 17 && hour < 22) return "Good evening";
  return "Working late";
}

const LINES: ReadonlyArray<(agents: number) => string> = [
  (agents) =>
    agents === 0
      ? // Reachable once Anbo knows which CLIs are installed: a bench that
        // counted agents nobody could pick would be inviting a dead click.
        "No agent on the bench yet — install a CLI and it shows up here."
      : agents === 1
        ? "One agent on the bench. Hand it the work."
        : `${agents} agents on the bench. Pick one and hand it the work.`,
  () => "A shell for you. A crew for everything else.",
  () => "Nothing open yet — the quiet before the run.",
  () => "Point an agent at this folder and watch the diff grow.",
  () => "One workspace. As many minds as you care to launch.",
  () => "Tabs are hands. Some of them think.",
];

/** A seed that changes with the workspace and with the calendar day. */
export function daySeed(name: string | null, date: Date): string {
  return `${name ?? ""}:${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

/** The line beneath the workspace name: stable for a seed, varied across them. */
export function taglineFor(seed: string, agents: number): string {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return LINES[hash % LINES.length](agents);
}

/** How many distinct lines the pool holds, for tests that sample it. */
export const TAGLINE_COUNT = LINES.length;

/**
 * The line under the marks on the first-run screen: who is on the bench,
 * named up to a point and counted past it.
 */
export function benchCaption(labels: readonly string[]): string {
  if (labels.length === 0) return "";
  if (labels.length === 1) return `${labels[0]} is on the bench.`;
  const named = labels.slice(0, 3);
  const rest = labels.length - named.length;
  const head =
    named.length === 2
      ? `${named[0]} and ${named[1]}`
      : `${named.slice(0, -1).join(", ")} and ${named[named.length - 1]}`;
  if (rest === 0) return `${head} are on the bench.`;
  return `${named.join(", ")} and ${rest} more are on the bench.`;
}
