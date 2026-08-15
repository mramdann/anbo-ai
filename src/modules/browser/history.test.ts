import { describe, expect, it } from "vitest";
import { parseBrowserHistory, withoutBrowserHistoryUrl } from "./history";

describe("browser history", () => {
  it("keeps supported entries sorted newest first", () => {
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

  it("rejects malformed storage", () => {
    expect(parseBrowserHistory("not-json")).toEqual([]);
    expect(
      parseBrowserHistory(JSON.stringify({ url: "https://example.com" })),
    ).toEqual([]);
  });

  it("removes only the selected URL", () => {
    const entries = [
      { url: "https://example.com", title: "Example", visitedAt: 2 },
      { url: "https://tauri.app", title: "Tauri", visitedAt: 1 },
    ];

    expect(withoutBrowserHistoryUrl(entries, "https://example.com")).toEqual([
      entries[1],
    ]);
    expect(entries).toHaveLength(2);
  });
});
