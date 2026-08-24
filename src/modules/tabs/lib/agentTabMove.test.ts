import { describe, expect, it } from "vitest";
import {
  adoptDetectedAgentIdentity,
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
  it("assigns a detected manual agent its canonical name and icon", () => {
    const plain: TerminalTab = {
      id: 1,
      kind: "terminal",
      spaceId: "a",
      title: "workspace",
      cwd: "/workspace",
      paneTree: { kind: "leaf", id: 101, cwd: "/workspace" },
      activeLeafId: 101,
    };

    expect(
      adoptDetectedAgentIdentity([plain], 101, {
        launcherId: "claude",
        icon: "claude",
        label: "Claude",
      })[0],
    ).toMatchObject({
      title: "Claude",
      agent: {
        launcherId: "claude",
        icon: "claude",
        label: "Claude",
        name: "Claude",
      },
    });
  });

  it("allocates a unique alias and preserves private or managed tabs", () => {
    const occupied = agentTab(1, "a", "Claude");
    const identity = {
      launcherId: "claude" as const,
      icon: "claude" as const,
      label: "Claude",
    };
    const plain: TerminalTab = {
      id: 2,
      kind: "terminal",
      spaceId: "a",
      title: "workspace",
      paneTree: { kind: "leaf", id: 102 },
      activeLeafId: 102,
    };
    const adopted = adoptDetectedAgentIdentity(
      [occupied, plain],
      102,
      identity,
    )[1] as TerminalTab;
    expect(adopted.agent?.name).not.toBe("Claude");
    expect(adopted.agent?.name.length).toBeLessThanOrEqual(7);

    const privateTab = { ...plain, private: true };
    expect(adoptDetectedAgentIdentity([privateTab], 102, identity)).toEqual([
      privateTab,
    ]);
    expect(adoptDetectedAgentIdentity([occupied], 101, identity)).toEqual([
      occupied,
    ]);
  });

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
