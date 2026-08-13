import { describe, expect, it } from "vitest";
import { planSpaceReset, type Tab } from "./useTabs";

function terminal(id: number, spaceId: string, leafId: number): Tab {
  return {
    id,
    kind: "terminal",
    spaceId,
    title: "shell",
    paneTree: { kind: "leaf", id: leafId },
    activeLeafId: leafId,
  };
}

describe("planSpaceReset", () => {
  it("replaces only the selected space and preserves every other tab", () => {
    const otherTerminal = terminal(3, "b", 30);
    const otherBrowser: Tab = {
      id: 4,
      kind: "browser",
      spaceId: "b",
      title: "running",
      url: "https://example.com",
      loading: true,
    };
    const tabs = [
      terminal(1, "a", 10),
      {
        id: 2,
        kind: "browser",
        spaceId: "a",
        title: "old",
        url: "https://example.org",
      } satisfies Tab,
      otherTerminal,
      otherBrowser,
    ];

    const result = planSpaceReset(tabs, "a", "C:\\next", 100, 101);

    expect(result.disposeLeafIds).toEqual([10]);
    expect(result.activeId).toBe(100);
    expect(result.tabs.slice(0, 2)).toEqual([otherTerminal, otherBrowser]);
    expect(result.tabs[0]).toBe(otherTerminal);
    expect(result.tabs[1]).toBe(otherBrowser);
    expect(result.tabs[2]).toMatchObject({
      id: 100,
      kind: "terminal",
      spaceId: "a",
      cwd: "C:\\next",
      activeLeafId: 101,
    });
  });
});
