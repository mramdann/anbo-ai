type HorizontalBounds = {
  left: number;
  right: number;
};

export function countClippedTabs(
  container: HorizontalBounds,
  tabs: readonly HorizontalBounds[],
  tolerance = 1,
): number {
  return tabs.filter(
    (tab) =>
      tab.left < container.left - tolerance ||
      tab.right > container.right + tolerance,
  ).length;
}

export function formatClippedTabCount(count: number): string {
  return String(Math.min(Math.max(0, count), 99));
}
