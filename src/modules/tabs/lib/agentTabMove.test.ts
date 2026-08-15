import { describe, expect, it } from "vitest";
import {
  createAgentTerminalTabs,
  moveTabIntoSpace,
  type Tab,
  type TerminalTab,
} from "./useTabs";

function agentTab(
  id: number,
  spaceId: string,
  name: string,
  launcherId: "claude" | "codex" = "claude",
): TerminalTab {
  return {
    id,
    kind: "terminal",
    spaceId,
    title: name,
    cwd: "/workspace",
    paneTree: { kind: "leaf", id: id + 100, cwd: "/workspace" },
    activeLeafId: id + 100,
    agent: {
      launcherId,
      icon: launcherId,
      label: launcherId === "claude" ? "Claude" : "Codex",
      name,
    },
  };
}

describe("agent tab cross-space moves", () => {
  it("preserves a callsign when the target workspace has no collision", () => {
    const source = agentTab(1, "a", "Atlas");
    expect(moveTabIntoSpace(source, [source], "b")).toMatchObject({
      spaceId: "b",
      title: "Atlas",
      agent: { name: "Atlas" },
    });
  });

  it("allocates a new callsign when the target workspace has a collision", () => {
    const source = agentTab(1, "a", "Atlas");
    const occupied = agentTab(2, "b", "Atlas", "codex");
    const moved = moveTabIntoSpace(source, [source, occupied] as Tab[], "b");
    expect(moved).toMatchObject({
      spaceId: "b",
      title: "Claude",
      agent: { name: "Claude" },
    });
  });
});

describe("agent tab creation", () => {
  it("creates one independent single-leaf tab per requested instance", () => {
    const tabs = createAgentTerminalTabs({
      spaceId: "a",
      cwd: "/workspace",
      agent: { launcherId: "claude", icon: "claude", label: "Claude" },
      tabIds: [1, 2, 3, 4],
      agentLeafIds: [101, 102, 103, 104],
    });
    const names = tabs.map((tab) => tab.agent?.name);
    expect(names[0]).toBe("Claude");
    expect(new Set(names).size).toBe(4);
    expect(names.slice(1).every((name) => name && name.length <= 7)).toBe(true);
    expect(
      tabs.every(
        (tab, index) =>
          tab.paneTree.kind === "leaf" &&
          tab.paneTree.id === 101 + index &&
          tab.activeLeafId === 101 + index,
      ),
    ).toBe(true);
  });

  it("rejects mismatched tab and leaf allocations", () => {
    expect(() =>
      createAgentTerminalTabs({
        spaceId: "a",
        cwd: undefined,
        agent: { launcherId: "claude", icon: "claude", label: "Claude" },
        tabIds: [1, 2],
        agentLeafIds: [101],
      }),
    ).toThrow(RangeError);
  });
});
