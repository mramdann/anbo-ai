import { labelFor } from "@/modules/tabs/lib/tabLabel";
import type { Tab } from "@/modules/tabs/lib/useTabs";

/** Workspaces that came back from the last session with tabs. */
export function spacesWithTabs(tabs: readonly Tab[]): string[] {
  return [...new Set(tabs.map((tab) => tab.spaceId))];
}

/**
 * A workspace waits for the user's word while it is pending and something of
 * it still sleeps. Opening it by mistake must start nothing: no shell, no
 * agent, no page.
 */
export function awaitsResume(
  pending: ReadonlySet<string>,
  tabs: readonly Tab[],
  spaceId: string,
): boolean {
  return (
    pending.has(spaceId) &&
    tabs.some((tab) => tab.spaceId === spaceId && tab.cold === true)
  );
}

/** A sleeping tab of a workspace that still waits does not wake by being shown. */
export function staysAsleep(
  pending: ReadonlySet<string>,
  tab: Pick<Tab, "cold" | "spaceId"> | undefined,
): boolean {
  return tab?.cold === true && pending.has(tab.spaceId);
}

/**
 * The pause screen takes the workspace's area while the tab in view is one of
 * its sleeping tabs. A tab opened since is shown as usual, and going back to a
 * sleeping one brings the screen back.
 */
export function resumeGateShown(
  pending: ReadonlySet<string>,
  tabs: readonly Tab[],
  spaceId: string,
  activeId: number,
): boolean {
  if (!awaitsResume(pending, tabs, spaceId)) return false;
  const active = tabs.find((tab) => tab.id === activeId);
  return !active || active.spaceId !== spaceId || active.cold === true;
}

/** The tabs a resume would wake and a fresh start would close. */
export function sleepingTabIds(
  tabs: readonly Tab[],
  spaceId: string,
): number[] {
  return tabs
    .filter((tab) => tab.spaceId === spaceId && tab.cold === true)
    .map((tab) => tab.id);
}

export type ResumeSummary = {
  /** Agent tabs, by the name their tab shows. */
  agents: string[];
  terminals: number;
  pages: number;
  files: number;
  others: number;
  /** Every sleeping tab's label, in tab order. */
  titles: string[];
};

/** What sleeps in a workspace. A tab opened since is not part of it. */
export function resumeSummary(
  tabs: readonly Tab[],
  spaceId: string,
): ResumeSummary {
  const summary: ResumeSummary = {
    agents: [],
    terminals: 0,
    pages: 0,
    files: 0,
    others: 0,
    titles: [],
  };
  for (const tab of tabs) {
    if (tab.spaceId !== spaceId || tab.cold !== true) continue;
    const label = labelFor(tab);
    summary.titles.push(label);
    if (tab.kind === "terminal") {
      if (tab.agent) summary.agents.push(label);
      else summary.terminals += 1;
    } else if (tab.kind === "browser") summary.pages += 1;
    else if (tab.kind === "editor" || tab.kind === "markdown") {
      summary.files += 1;
    } else summary.others += 1;
  }
  return summary;
}

function counted(count: number, one: string, many: string): string | null {
  return count === 0 ? null : `${count} ${count === 1 ? one : many}`;
}

/** "3 agents, 2 terminals, 4 browser tabs, 1 file". */
export function resumeSummaryLine(summary: ResumeSummary): string {
  return [
    counted(summary.agents.length, "agent", "agents"),
    counted(summary.terminals, "terminal", "terminals"),
    counted(summary.pages, "browser tab", "browser tabs"),
    counted(summary.files, "file", "files"),
    counted(summary.others, "other tab", "other tabs"),
  ]
    .filter((part) => part !== null)
    .join(", ");
}
