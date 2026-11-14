/** Why a browser tab did not come to the front of its panel: it shares the
 * panel with the tab the user is working in (`in-use`: a terminal or an
 * editor), the panel shows a page of the user's own that they chose
 * (`in-use-page`), or the shown layout lacks it. */
export type BrowserTabShowOutcome =
  | "shown"
  | "in-use"
  | "in-use-page"
  | "missing";
type Show = (tabId: number) => BrowserTabShowOutcome;

/** What a group shows in place of the tab that is asked for: the page of
 * their own the user chose there, any other page, or a terminal, an editor or
 * another tab. */
type BrowserTabInFront = "users-page" | "page" | "other";

/** How a tab comes forward in its group. A group the user is not in reveals
 * it, the way an agent's new tab comes forward; the group in use changes only
 * from one page to another, so its terminal or editor stays.
 *
 * A page of the user's own, which they chose themselves, stays in front of
 * its panel wherever the user is until they choose another tab. In round 102
 * a real agent's tab took the browser panel from the page the user had left
 * in front twice in 41 returns to a workspace: Anbo puts the caret into a
 * terminal when a workspace is shown again, which made the browser panel one
 * the user was "not in" (R102-1). */
export function planBrowserTabShow(panel: {
  found: boolean;
  front: boolean;
  groupInUse: boolean;
  inFront: BrowserTabInFront;
}): { outcome: BrowserTabShowOutcome; step: "none" | "reveal" | "select" } {
  if (!panel.found) return { outcome: "missing", step: "none" };
  if (panel.front) return { outcome: "shown", step: "none" };
  if (panel.inFront === "users-page") {
    return { outcome: "in-use-page", step: "none" };
  }
  if (!panel.groupInUse) return { outcome: "shown", step: "reveal" };
  return panel.inFront === "page"
    ? { outcome: "shown", step: "select" }
    : { outcome: "in-use", step: "none" };
}

/** Which page of a workspace's browser panel is the user's own choice after
 * they used `tab` themselves (pressed its head, or went into its page): that
 * tab, unless an agent ever drove it. Choosing an agent's tab to watch ends
 * the choice, and agents' tabs come forward by themselves again. */
export function usersPageAfterUse(tab: {
  id: number;
  everDriven: boolean;
}): number | null {
  return tab.everDriven ? null : tab.id;
}

const userUseListeners = new Set<(tabId: number) => void>();

/** The user did something in a browser tab themselves. */
export function noteUserUsedBrowserTab(tabId: number): void {
  for (const listener of userUseListeners) listener(tabId);
}

export function subscribeUserUsedBrowserTab(
  listener: (tabId: number) => void,
): () => void {
  userUseListeners.add(listener);
  return () => {
    userUseListeners.delete(listener);
  };
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
