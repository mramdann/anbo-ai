export type BrowserHistoryEntry = {
  url: string;
  title: string;
  visitedAt: number;
};

export const BROWSER_HISTORY_EVENT = "anbo:browser-history-changed";
const STORAGE_KEY = "anbo-browser-history-v1";
const MAX_ENTRIES = 100;

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

export function parseBrowserHistory(raw: string | null): BrowserHistoryEntry[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
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
  } catch {
    return [];
  }
}

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readBrowserHistory(): BrowserHistoryEntry[] {
  return parseBrowserHistory(storage()?.getItem(STORAGE_KEY) ?? null);
}

export function recordBrowserVisit(
  url: string,
  title?: string | null,
  visitedAt = Date.now(),
): void {
  if (!supportedHistoryUrl(url)) return;
  const target = storage();
  if (!target) return;
  const previous = readBrowserHistory();
  const existing = previous.find((entry) => entry.url === url);
  const entry: BrowserHistoryEntry = {
    url,
    title: title?.trim().slice(0, 200) || existing?.title || fallbackTitle(url),
    visitedAt,
  };
  target.setItem(
    STORAGE_KEY,
    JSON.stringify(
      [entry, ...previous.filter((item) => item.url !== url)].slice(
        0,
        MAX_ENTRIES,
      ),
    ),
  );
  window.dispatchEvent(new Event(BROWSER_HISTORY_EVENT));
}

export function clearBrowserHistory(): void {
  storage()?.removeItem(STORAGE_KEY);
  window.dispatchEvent(new Event(BROWSER_HISTORY_EVENT));
}

export function withoutBrowserHistoryUrl(
  entries: readonly BrowserHistoryEntry[],
  url: string,
): BrowserHistoryEntry[] {
  return entries.filter((entry) => entry.url !== url);
}

export function removeBrowserHistoryEntry(url: string): void {
  const target = storage();
  if (!target) return;
  const next = withoutBrowserHistoryUrl(readBrowserHistory(), url);
  if (next.length === 0) target.removeItem(STORAGE_KEY);
  else target.setItem(STORAGE_KEY, JSON.stringify(next));
  window.dispatchEvent(new Event(BROWSER_HISTORY_EVENT));
}
