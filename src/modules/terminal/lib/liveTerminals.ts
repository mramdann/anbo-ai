import type { Tab, TerminalTab } from "@/modules/tabs/lib/useTabs";
import { leafIds } from "./panes";

/**
 * Terminal tabs that TerminalStack mounts. Cold tabs (restored, not yet
 * activated) are excluded so no PTY is spawned until first activation.
 */
export function selectLiveTerminals(tabs: Tab[]): TerminalTab[] {
  return tabs.filter((t): t is TerminalTab => t.kind === "terminal" && !t.cold);
}

export function collectRetainedTerminalLeafIds(tabs: Tab[]): Set<number> {
  const retained = new Set<number>();
  for (const tab of tabs) {
    if (tab.kind !== "terminal") continue;
    for (const leafId of leafIds(tab.paneTree)) retained.add(leafId);
  }
  return retained;
}
