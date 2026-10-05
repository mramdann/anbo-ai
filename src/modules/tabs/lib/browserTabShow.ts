/** Why a browser tab did not come to the front of its panel: it shares the
 * panel with the tab the user is working in, or the shown layout lacks it. */
export type BrowserTabShowOutcome = "shown" | "in-use" | "missing";
type Show = (tabId: number) => BrowserTabShowOutcome;

/** How a tab comes forward in its group. A group the user is not in reveals
 * it, the way an agent's new tab comes forward; the group in use changes only
 * from one browser tab to another, so its terminal or editor stays. */
export function planBrowserTabShow(panel: {
  found: boolean;
  front: boolean;
  groupInUse: boolean;
  frontIsBrowser: boolean;
}): { outcome: BrowserTabShowOutcome; step: "none" | "reveal" | "select" } {
  if (!panel.found) return { outcome: "missing", step: "none" };
  if (panel.front) return { outcome: "shown", step: "none" };
  if (!panel.groupInUse) return { outcome: "shown", step: "reveal" };
  return panel.frontIsBrowser
    ? { outcome: "shown", step: "select" }
    : { outcome: "in-use", step: "none" };
}

let shower: { spaceId: string; show: Show } | null = null;
const shownListeners = new Set<(tabId: number) => void>();

/** The shown workspace's dock brings its tabs to the front on request. */
export function registerBrowserTabShow(
  spaceId: string,
  show: Show,
): () => void {
  const entry = { spaceId, show };
  shower = entry;
  return () => {
    if (shower === entry) shower = null;
  };
}

/** A Chrome or Edge page takes pointer input only while it is shown, so an
 * agent's click brings its tab to the front of its panel first. The page then
 * takes the dock, as it does after a click on the panel. */
export function showBrowserTabForInput(
  spaceId: string,
  tabId: number,
): BrowserTabShowOutcome {
  const outcome = shower?.spaceId === spaceId ? shower.show(tabId) : "missing";
  if (outcome === "shown") {
    for (const listener of shownListeners) listener(tabId);
  }
  return outcome;
}

export function subscribeBrowserTabShown(
  listener: (tabId: number) => void,
): () => void {
  shownListeners.add(listener);
  return () => {
    shownListeners.delete(listener);
  };
}
