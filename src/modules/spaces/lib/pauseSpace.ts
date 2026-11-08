import type { BrowserTab, Tab, TerminalTab } from "@/modules/tabs/lib/useTabs";
import { leafIds } from "@/modules/terminal/lib/panes";
import { reopenedTerminalTab } from "./serialize";

/**
 * What a space runs that a pause would stop: shells, agent CLIs and pages of
 * Anbo's own browser. Chrome/Edge pages belong to the user's browser and an
 * editor holds no process, so neither counts.
 *
 * A space whose such tabs are all cold is paused, however it got there: a
 * space behind the shown one after Anbo starts runs nothing either until it is
 * opened.
 */
export type SpaceRunState = "running" | "paused" | "idle";

function runsProcesses(tab: Tab): tab is TerminalTab | BrowserTab {
  return tab.kind === "terminal" || (tab.kind === "browser" && !tab.external);
}

export function spaceRunState(
  tabs: readonly Tab[],
  spaceId: string,
): SpaceRunState {
  let paused = false;
  for (const tab of tabs) {
    if (tab.spaceId !== spaceId || !runsProcesses(tab)) continue;
    if (!tab.cold) return "running";
    paused = true;
  }
  return paused ? "paused" : "idle";
}

/**
 * Pausing a space puts its tabs back where a restart leaves them: shells and
 * agents end, agents keep what they need to resume their conversation, and
 * pages of Anbo's browser close and keep their address. The tabs stay, with
 * their ids, so a tool that holds one wakes it instead of losing it. Editors,
 * Chrome/Edge tabs and tabs already cold are left as they are. App ends the
 * processes once the cold tabs are rendered.
 */
export function planSpacePause(tabs: Tab[], spaceId: string): Tab[] | null {
  let changed = false;
  const next = tabs.map((tab): Tab => {
    if (tab.spaceId !== spaceId || tab.cold || !runsProcesses(tab)) return tab;
    changed = true;
    if (tab.kind === "terminal") return reopenedTerminalTab(tab);
    const { loading: _loading, ...page } = tab;
    return { ...page, cold: true };
  });
  return changed ? next : null;
}

/** The terminal tabs a resume starts: every shell and agent of the space. Its
 *  browser pages load when shown or used, as after a restart. */
export function spaceResumeTabIds(
  tabs: readonly Tab[],
  spaceId: string,
): number[] {
  return tabs
    .filter(
      (tab) => tab.spaceId === spaceId && tab.kind === "terminal" && tab.cold,
    )
    .map((tab) => tab.id);
}

/** Leaves of terminal tabs that are cold now and were not before: their
 *  shells have to end. A tab that left is the close path's to dispose. */
export function newlyColdLeaves(
  before: ReadonlyMap<number, readonly number[]>,
  tabs: readonly Tab[],
): number[] {
  const leaves: number[] = [];
  for (const tab of tabs) {
    if (tab.kind !== "terminal" || !tab.cold) continue;
    const warm = before.get(tab.id);
    if (warm) leaves.push(...warm);
  }
  return leaves;
}

/** Warm terminal tabs by id, with their leaves, for `newlyColdLeaves`. */
export function warmTerminalLeaves(
  tabs: readonly Tab[],
): Map<number, number[]> {
  const warm = new Map<number, number[]>();
  for (const tab of tabs) {
    if (tab.kind === "terminal" && !tab.cold) {
      warm.set(tab.id, leafIds(tab.paneTree));
    }
  }
  return warm;
}

/** Ids of the tabs of Anbo's browser whose page is open. */
export function warmBrowserTabIds(tabs: readonly Tab[]): Set<number> {
  const warm = new Set<number>();
  for (const tab of tabs) {
    if (tab.kind === "browser" && !tab.cold && !tab.external) warm.add(tab.id);
  }
  return warm;
}

/** Tabs of Anbo's browser whose page was open and that are cold now. */
export function newlyColdBrowserTabs(
  before: ReadonlySet<number>,
  tabs: readonly Tab[],
): number[] {
  return tabs
    .filter(
      (tab) =>
        tab.kind === "browser" && tab.cold === true && before.has(tab.id),
    )
    .map((tab) => tab.id);
}

/** What is still at work in a space a pause would stop, for its confirmation. */
export type SpacePauseWork = {
  /** Agents in a turn, by the name their tab shows. */
  agents: string[];
  /** Programs running in a shell, with the tab they run in. */
  programs: Array<{ tab: string; names: string[] }>;
  /** Pages an agent is driving right now, by tab title. */
  pages: string[];
};

const LISTED = 4;

function listed(items: string[]): string {
  const shown = items.slice(0, LISTED);
  const more = items.length - shown.length;
  return more > 0 ? `${shown.join(", ")} and ${more} more` : shown.join(", ");
}

/** The confirmation's lines, or none when nothing is at work. */
export function spacePauseWorkLines(work: SpacePauseWork): string[] {
  const lines: string[] = [];
  if (work.agents.length > 0) {
    lines.push(
      `${work.agents.length === 1 ? "An agent is" : `${work.agents.length} agents are`} in the middle of a task: ${listed(work.agents)}. The task stops; the agent resumes its conversation when the space comes back.`,
    );
  }
  if (work.programs.length > 0) {
    const programs = work.programs.map(
      ({ tab, names }) => `${names.join(", ")} in ${tab}`,
    );
    lines.push(
      `${work.programs.length === 1 ? "A program is" : `${work.programs.length} programs are`} running: ${listed(programs)}. ${work.programs.length === 1 ? "It ends" : "They end"}, and the terminal opens a new shell when the space comes back.`,
    );
  }
  if (work.pages.length > 0) {
    lines.push(
      `An agent is using ${work.pages.length === 1 ? "a page" : `${work.pages.length} pages`}: ${listed(work.pages)}. ${work.pages.length === 1 ? "It closes and loads again" : "They close and load again"} when shown or used.`,
    );
  }
  return lines;
}
