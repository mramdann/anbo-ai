import { LocalLazyStore } from "@/lib/localStore";

const STORE_PATH = "anbo-workspace-layouts.json";
// Where the layouts were kept before, one key per space. Chromium hands every
// localStorage write, value and all, to each renderer of the app's origin, and
// the AnboVoice orb's renderer kept about 2.4 bytes for each character written
// there, for good (WebView2 156): a layout was rewritten on every tab change.
const LEGACY_PREFIX = "anbo:workspace-dockview-layout:";

const store = new LocalLazyStore(STORE_PATH, { defaults: {}, autoSave: 500 });
const layouts = new Map<string, string>();
let loaded = false;
let loading: Promise<void> | null = null;
let writes: Promise<void> = Promise.resolve();

function legacyStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

// One write after another, so the file ends with the last layout given.
function keep(key: string, value: string): void {
  writes = writes.then(() => store.set(key, value)).catch(() => {});
}

/** Reads the kept layouts once per app run, moving the ones an older version
 * kept in localStorage. The spaces boot awaits it before any workspace shows,
 * so a workspace reads its layout synchronously when it loads. */
export function loadWorkspaceLayouts(): Promise<void> {
  loading ??= (async () => {
    let stored: Array<[string, unknown]> | null = null;
    try {
      stored = await store.entries<unknown>();
    } catch {
      stored = null;
    }
    for (const [key, value] of stored ?? []) {
      if (typeof value === "string") layouts.set(key, value);
    }
    const legacy = legacyStorage();
    if (legacy) {
      const keys: string[] = [];
      for (let index = 0; index < legacy.length; index++) {
        const key = legacy.key(index);
        if (key?.startsWith(LEGACY_PREFIX)) keys.push(key);
      }
      for (const key of keys) {
        const value = legacy.getItem(key);
        if (value !== null && !layouts.has(key)) {
          layouts.set(key, value);
          keep(key, value);
        }
        // The old copy goes only once the file has answered.
        if (stored) legacy.removeItem(key);
      }
    }
    loaded = true;
  })();
  return loading;
}

/** The layouts as the workspace persistence reads and writes them. */
export const workspaceLayoutStorage = {
  getItem(key: string): string | null {
    return layouts.get(key) ?? null;
  },
  setItem(key: string, value: string): void {
    // A workspace loads only after the boot awaited the kept layouts, so a
    // write before them comes from a module a Dev hot update put up anew; it
    // was made without them and would replace them.
    if (!loaded || layouts.get(key) === value) return;
    layouts.set(key, value);
    keep(key, value);
  },
};

/** Waits for the layout writes made so far, then saves the file. */
export async function saveWorkspaceLayouts(): Promise<void> {
  await writes;
  await store.save().catch(() => {});
}
