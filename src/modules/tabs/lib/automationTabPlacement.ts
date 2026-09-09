export type AutomationTabPlacement =
  | "visible-first-tab"
  | "visible-background-tab"
  | "inactive-workspace";

export function automationTabPlacement(
  targetSpaceId: string,
  activeSpaceId: string | null,
  hasWorkspaceTabs: boolean,
): AutomationTabPlacement {
  if (targetSpaceId !== activeSpaceId) return "inactive-workspace";
  return hasWorkspaceTabs ? "visible-background-tab" : "visible-first-tab";
}

/** One reservation shared by browser, terminal and agent creation until React commits. */
export function createAutomationTabSelection() {
  const pending = new Map<string, number>();
  return {
    placement(
      spaceId: string,
      activeSpaceId: string | null,
      tabs: readonly { spaceId: string }[],
    ) {
      return automationTabPlacement(
        spaceId,
        activeSpaceId,
        pending.has(spaceId) || tabs.some((tab) => tab.spaceId === spaceId),
      );
    },
    created(spaceId: string, tabId: number, placement: AutomationTabPlacement) {
      if (placement === "visible-first-tab") pending.set(spaceId, tabId);
    },
    reconcile(tabs: readonly { id: number }[]) {
      for (const [spaceId, tabId] of pending) {
        if (tabs.some((tab) => tab.id === tabId)) pending.delete(spaceId);
      }
    },
    closed(tabId: number) {
      for (const [spaceId, pendingId] of pending) {
        if (pendingId === tabId) pending.delete(spaceId);
      }
    },
  };
}
