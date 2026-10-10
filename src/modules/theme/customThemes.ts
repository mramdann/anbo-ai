import { LocalLazyStore } from "@/lib/localStore";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Theme } from "./types";

const STORE_PATH = "anbo-custom-themes.json";
const KEY = "themes";
const CHANGED_EVENT = "anbo://custom-themes-changed";

const store = new LocalLazyStore(STORE_PATH, { defaults: {}, autoSave: 200 });

export async function listCustomThemes(): Promise<Theme[]> {
  const v = await store.get<Theme[]>(KEY);
  return Array.isArray(v) ? v : [];
}

export async function saveCustomTheme(theme: Theme): Promise<void> {
  const current = await listCustomThemes();
  const next = current.filter((t) => t.id !== theme.id).concat(theme);
  await store.set(KEY, next);
  await store.save();
  await emit(CHANGED_EVENT);
}

export async function deleteCustomTheme(id: string): Promise<void> {
  const current = await listCustomThemes();
  const next = current.filter((t) => t.id !== id);
  if (next.length === current.length) return;
  await store.set(KEY, next);
  await store.save();
  await emit(CHANGED_EVENT);
}

// Saving and deleting announce the change to every window, this one included
// (see PREFS_CHANGED_EVENT in settings/store for why not LazyStore.onChange).
export async function onCustomThemesChange(
  cb: () => void,
): Promise<UnlistenFn> {
  return listen(CHANGED_EVENT, () => cb());
}
