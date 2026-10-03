import type { Tab } from "./useTabs";

// Runtime tab ids restart at 1 on every launch, so a saved panel layout that
// matched them put tabs into each other's panels once a tab or split earlier
// in the workspace list shifted the count. A layout key names the same tab in
// every launch: the one restored from disk, or this launch's for its id.
const LAUNCH_ID =
  globalThis.crypto?.randomUUID?.() ??
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

const MAX_TAB_LAYOUT_KEY_LENGTH = 128;

export function tabLayoutKey(tab: Pick<Tab, "id" | "layoutKey">): string {
  return tab.layoutKey ?? `${LAUNCH_ID}:${tab.id}`;
}

export function isTabLayoutKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_TAB_LAYOUT_KEY_LENGTH
  );
}
