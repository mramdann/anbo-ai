import { beforeEach, describe, expect, it, vi } from "vitest";

const kept = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
  sets: 0,
  release: null as null | (() => void),
}));

vi.mock("@/lib/localStore", () => ({
  LocalLazyStore: class {
    async get(key: string) {
      // A test can hold the load back to make visits before it arrives.
      if (kept.release === null) return kept.store.get(key);
      await new Promise<void>((resolve) => {
        const release = kept.release;
        kept.release = () => {
          release?.();
          resolve();
        };
      });
      return kept.store.get(key);
    }
    async set(key: string, value: unknown) {
      kept.sets += 1;
      kept.store.set(key, value);
    }
  },
}));

const legacyKey = "anbo-browser-history-v1";
const local = new Map<string, string>();

beforeEach(() => {
  vi.resetModules();
  kept.store.clear();
  kept.sets = 0;
  kept.release = null;
  local.clear();
  vi.stubGlobal(
    "window",
    Object.assign(new EventTarget(), {
      localStorage: {
        getItem: (key: string) => local.get(key) ?? null,
        setItem: (key: string, value: string) => local.set(key, value),
        removeItem: (key: string) => local.delete(key),
      },
    }),
  );
});

const history = () => import("./history");

describe("browser history", () => {
  it("keeps supported entries sorted newest first", async () => {
    const { parseBrowserHistory } = await history();
    const entries = parseBrowserHistory(
      JSON.stringify([
        { url: "https://example.com", title: "Example", visitedAt: 2 },
        {
          url: "file:///C:/workspace/index.html",
          title: "Local",
          visitedAt: 3,
        },
        { url: "javascript:alert(1)", title: "Unsafe", visitedAt: 4 },
        { url: "https://tauri.app", title: "Tauri", visitedAt: 1 },
      ]),
    );

    expect(entries.map((entry) => entry.title)).toEqual([
      "Local",
      "Example",
      "Tauri",
    ]);
  });

  it("rejects malformed storage", async () => {
    const { parseBrowserHistory } = await history();
    expect(parseBrowserHistory("not-json")).toEqual([]);
    expect(
      parseBrowserHistory(JSON.stringify({ url: "https://example.com" })),
    ).toEqual([]);
  });

  it("removes only the selected URL", async () => {
    const { withoutBrowserHistoryUrl } = await history();
    const entries = [
      { url: "https://example.com", title: "Example", visitedAt: 2 },
      { url: "https://tauri.app", title: "Tauri", visitedAt: 1 },
    ];

    expect(withoutBrowserHistoryUrl(entries, "https://example.com")).toEqual([
      entries[1],
    ]);
    expect(entries).toHaveLength(2);
  });

  it("keeps visits in the app's store, never in localStorage", async () => {
    // Every localStorage write reaches each window of the origin, and the
    // orb's renderer kept what it was handed.
    const { loadBrowserHistory, readBrowserHistory, recordBrowserVisit } =
      await history();
    await loadBrowserHistory();
    recordBrowserVisit("https://example.com/a", "A", 1);
    recordBrowserVisit("https://example.com/a", null, 2);
    expect(readBrowserHistory()).toEqual([
      { url: "https://example.com/a", title: "A", visitedAt: 2 },
    ]);
    expect(kept.store.get("entries")).toEqual(readBrowserHistory());
    expect(local.size).toBe(0);
  });

  it("moves the history an older version kept in localStorage, once", async () => {
    local.set(
      legacyKey,
      JSON.stringify([{ url: "https://old.test", title: "Old", visitedAt: 5 }]),
    );
    const { loadBrowserHistory, readBrowserHistory } = await history();
    await loadBrowserHistory();
    expect(readBrowserHistory().map((entry) => entry.url)).toEqual([
      "https://old.test",
    ]);
    expect(kept.store.get("entries")).toEqual(readBrowserHistory());
    expect(local.has(legacyKey)).toBe(false);
    // A store that already holds the history wins over a leftover key.
    local.set(legacyKey, JSON.stringify([]));
    vi.resetModules();
    const again = await history();
    await again.loadBrowserHistory();
    expect(again.readBrowserHistory().map((entry) => entry.url)).toEqual([
      "https://old.test",
    ]);
    expect(local.has(legacyKey)).toBe(false);
  });

  it("puts a visit made before the kept history arrived on top of it", async () => {
    kept.store.set("entries", [
      { url: "https://kept.test", title: "Kept", visitedAt: 1 },
      { url: "https://gone.test", title: "Gone", visitedAt: 0 },
    ]);
    kept.release = () => {};
    const {
      BROWSER_HISTORY_EVENT,
      loadBrowserHistory,
      readBrowserHistory,
      recordBrowserVisit,
      removeBrowserHistoryEntry,
    } = await history();
    const changed = vi.fn();
    window.addEventListener(BROWSER_HISTORY_EVENT, changed);
    recordBrowserVisit("https://early.test", "Early", 9);
    removeBrowserHistoryEntry("https://gone.test");
    expect(readBrowserHistory().map((entry) => entry.url)).toEqual([
      "https://early.test",
    ]);
    expect(kept.sets).toBe(0);
    kept.release?.();
    await loadBrowserHistory();
    expect(readBrowserHistory().map((entry) => entry.url)).toEqual([
      "https://early.test",
      "https://kept.test",
    ]);
    expect(kept.store.get("entries")).toEqual(readBrowserHistory());
    expect(changed).toHaveBeenCalledTimes(3);
  });

  it("clears what was kept", async () => {
    kept.store.set("entries", [
      { url: "https://kept.test", title: "Kept", visitedAt: 1 },
    ]);
    const { clearBrowserHistory, loadBrowserHistory, readBrowserHistory } =
      await history();
    await loadBrowserHistory();
    clearBrowserHistory();
    expect(readBrowserHistory()).toEqual([]);
    expect(kept.store.get("entries")).toEqual([]);
  });
});
