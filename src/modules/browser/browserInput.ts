const GOOGLE_SEARCH_URL = "https://www.google.com/search?q=";

export function resolveBrowserInput(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;

  const localFile = windowsPathToFileUrl(value);
  if (localFile) return localFile;
  if (/^file:\/\//i.test(value))
    return isFileUrl(value) ? new URL(value).href : null;
  if (/^https?:\/\//i.test(value)) {
    return isHttpUrl(value) ? value : null;
  }
  if (/^localhost(?::|\/|$)/i.test(value)) return `http://${value}`;
  if (/^\d{1,3}(?:\.\d{1,3}){3}(?::|\/|$)/.test(value)) {
    return `http://${value}`;
  }
  if (/^\[::1\](?::|\/|$)/.test(value)) return `http://${value}`;
  if (/^[^\s/]+\.[^\s]+/.test(value)) {
    const candidate = `https://${value}`;
    if (isHttpUrl(candidate)) return candidate;
  }

  return `${GOOGLE_SEARCH_URL}${encodeURIComponent(value)}`;
}

export function windowsPathToFileUrl(value: string): string | null {
  if (!/^[a-zA-Z]:[\\/]/.test(value)) return null;
  const normalized = value.replace(/\\/g, "/");
  const drive = normalized.slice(0, 2);
  const segments = normalized
    .slice(3)
    .split("/")
    .map((segment) => encodeURIComponent(segment));
  return `file:///${drive}/${segments.join("/")}`;
}

export function faviconUrlForPage(value: string): string | null {
  try {
    const page = new URL(value);
    if (page.protocol !== "http:" && page.protocol !== "https:") return null;
    return new URL("/favicon.ico", page).toString();
  } catch {
    return null;
  }
}

/**
 * Secondary favicon source: Google's favicon service. Used as a fallback when
 * the site's own `/favicon.ico` 404s — many sites put their icon at a custom
 * path declared via `<link rel="icon">`, which the conventional lookup misses.
 * Google crawls and caches these, so it resolves favicons the direct lookup
 * can't, at the cost of a request to a public host.
 */
export function googleFaviconUrlForPage(value: string): string | null {
  try {
    const page = new URL(value);
    if (page.protocol !== "http:" && page.protocol !== "https:") return null;
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(page.hostname)}&sz=64`;
  } catch {
    return null;
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isFileUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "file:";
  } catch {
    return false;
  }
}
