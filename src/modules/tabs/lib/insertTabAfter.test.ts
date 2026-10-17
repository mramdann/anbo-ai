import { describe, expect, it } from "vitest";
import { insertTabAfter, type Tab } from "./useTabs";

const browser = (id: number): Tab => ({
  id,
  kind: "browser",
  spaceId: "work",
  title: `Tab ${id}`,
  url: `https://example.com/${id}`,
});

describe("insertTabAfter", () => {
  it("places a tab right after the one it was opened from", () => {
    const tabs = [browser(1), browser(2), browser(3)];
    expect(insertTabAfter(tabs, browser(9), 1).map((tab) => tab.id)).toEqual([
      1, 9, 2, 3,
    ]);
    expect(insertTabAfter(tabs, browser(9), 3).map((tab) => tab.id)).toEqual([
      1, 2, 3, 9,
    ]);
  });

  it("appends a tab opened from no tab, or from one that is gone", () => {
    const tabs = [browser(1), browser(2)];
    expect(insertTabAfter(tabs, browser(9)).map((tab) => tab.id)).toEqual([
      1, 2, 9,
    ]);
    expect(insertTabAfter(tabs, browser(9), 7).map((tab) => tab.id)).toEqual([
      1, 2, 9,
    ]);
    expect(tabs.map((tab) => tab.id)).toEqual([1, 2]);
  });
});
