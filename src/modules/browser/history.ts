import { LocalLazyStore } from "@/lib/localStore";

export type BrowserHistoryEntry = {
  url: string;
  title: string;
  visitedAt: number;
};

export const BROWSER_HISTORY_EVENT = "anbo:browser-history-changed";
const STORE_PATH = "anbo-browser-history.json";
const KEY = "entries";
// Where the history was kept before. Chromium hands every localStorage write,
// value and all, to each renderer of the app's origin, and the AnboVoice orb's
// renderer kept about 2.4 bytes for each character written there, for good
// (WebView2 156): the whole history was rewritten twice a visit.
const LEGACY_STORAGE_KEY = "anbo-browser-history-v1";
const MAX_ENTRIES = 100;

const store = new LocalLazyStore(STORE_PATH, { defaults: {}, autoSave: 500 });

function supportedHistoryUrl(value: string): boolean {
  try {
    return ["http:", "https:", "file:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function fallbackTitle(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "file:") {
      const file = decodeURIComponent(parsed.pathname)
        .split("/")
        .filter(Boolean)
        .pop();
      return file || "Local file";
    }
    return parsed.hostname || url;
  } catch {
    return url;
  }
}

function validBrowserHistory(value: unknown): BrowserHistoryEntry[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (entry): entry is BrowserHistoryEntry =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as BrowserHistoryEntry).url === "string" &&
        supportedHistoryUrl((entry as BrowserHistoryEntry).url) &&
        typeof (entry as BrowserHistoryEntry).title === "string" &&
        Number.isFinite((entry as BrowserHistoryEntry).visitedAt),
    )
    .sort((left, right) => right.visitedAt - left.visitedAt)
    .slice(0, MAX_ENTRIES);
}

export function parseBrowserHistory(raw: string | null): BrowserHistoryEntry[] {
  if (!raw) return [];
  try {
    return validBrowserHistory(JSON.parse(raw));
  } catch {
    return [];
  }
}

type Change = (entries: BrowserHistoryEntry[]) => BrowserHistoryEntry[];

let entries: BrowserHistoryEntry[] = [];
// Changes made before the stored history arrived, replayed on top of it so
// an early visit never replaces what was kept.
let early: Change[] | null = [];
let loading: Promise<void> | null = null;

function legacyStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function save(): void {
  void store.set(KEY, entries).catch(() => {});
}

/** Loads the kept history once per app run, moving one an older version kept
 * in localStorage; every read and change starts it. */
export function loadBrowserHistory(): Promise<void> {
  loading ??= (async () => {
    let stored: unknown;
    try {
      stored = await store.get<unknown>(KEY);
    } catch {
      stored = undefined;
    }
    let kept = validBrowserHistory(stored);
    const legacy = legacyStorage();
    const old = legacy?.getItem(LEGACY_STORAGE_KEY) ?? null;
    if (old !== null) {
      if (stored === undefined) kept = parseBrowserHistory(old);
      legacy?.removeItem(LEGACY_STORAGE_KEY);
    }
    const changes = early ?? [];
    early = null;
    entries = changes.reduce((list, change) => change(list), kept);
    if (old !== null || changes.length > 0) save();
    window.dispatchEvent(new Event(BROWSER_HISTORY_EVENT));
  })();
  return loading;
}

function change(next: Change): void {
  entries = next(entries);
  if (early) early.push(next);
  else save();
  void loadBrowserHistory();
  window.dispatchEvent(new Event(BROWSER_HISTORY_EVENT));
}

export function readBrowserHistory(): BrowserHistoryEntry[] {
  void loadBrowserHistory();
  return entries;
}

export function recordBrowserVisit(
  url: string,
  title?: string | null,
  visitedAt = Date.now(),
): void {
  if (!supportedHistoryUrl(url)) return;
  change((list) => {
    const existing = list.find((entry) => entry.url === url);
    const entry: BrowserHistoryEntry = {
      url,
      title:
        title?.trim().slice(0, 200) || existing?.title || fallbackTitle(url),
      visitedAt,
    };
    return [entry, ...list.filter((item) => item.url !== url)].slice(
      0,
      MAX_ENTRIES,
    );
  });
}

export function clearBrowserHistory(): void {
  change(() => []);
}

export function withoutBrowserHistoryUrl(
  entries: readonly BrowserHistoryEntry[],
  url: string,
): BrowserHistoryEntry[] {
  return entries.filter((entry) => entry.url !== url);
}

export function removeBrowserHistoryEntry(url: string): void {
  change((list) => withoutBrowserHistoryUrl(list, url));
}
