const GOOGLE_SEARCH_URL = "https://www.google.com/search?q=";

export function resolveBrowserInput(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;

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

export function faviconUrlForPage(value: string): string | null {
  try {
    const page = new URL(value);
    if (page.protocol !== "http:" && page.protocol !== "https:") return null;
    return new URL("/favicon.ico", page).toString();
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
