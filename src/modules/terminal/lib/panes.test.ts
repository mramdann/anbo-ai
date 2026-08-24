import {
  deactivateLeafAgentResume,
  firstLeafSlotId,
  leafIds,
  type PaneNode,
  pinLeafAgentResumeSession,
  rearmLeafAgentResume,
  swapLeafInDirection,
} from "@/modules/terminal/lib/panes";
import { describe, expect, it } from "vitest";

describe("pinLeafAgentResumeSession", () => {
  it("pins a discovered session id and arms the selected leaf", () => {
    const tree: PaneNode = {
      kind: "leaf",
      id: 1,
      agentResume: {
        agent: "opencode",
        armed: false,
        command: "opencode",
      },
    };
    const pinned = pinLeafAgentResumeSession(tree, 1, "ses_test123");
    expect(pinned).toEqual({
      kind: "leaf",
      id: 1,
      agentResume: {
        agent: "opencode",
        armed: true,
        command: "opencode",
        sessionId: "ses_test123",
      },
    });
  });

  it("keeps a dormant descriptor but drops the stale session on exit", () => {
    const tree: PaneNode = {
      kind: "leaf",
      id: 1,
      cwd: "C:/work",
      agentResume: {
        agent: "claude",
        armed: true,
        command: "claude",
        resumeOnStart: true,
        sessionId: "session-id",
      },
    };

    expect(deactivateLeafAgentResume(tree, 1)).toEqual({
      kind: "leaf",
      id: 1,
      cwd: "C:/work",
      agentResume: {
        agent: "claude",
        command: "claude",
        armed: false,
      },
    });
  });

  it("rearms discovery when the same agent is launched manually", () => {
    const tree: PaneNode = {
      kind: "leaf",
      id: 1,
      agentResume: {
        agent: "codex",
        command: "codex --model test",
        armed: false,
      },
    };

    expect(rearmLeafAgentResume(tree, 1, "codex", 1234)).toEqual({
      kind: "leaf",
      id: 1,
      agentResume: {
        agent: "codex",
        command: "codex --model test",
        armed: false,
        discoveryStartedAt: 1234,
      },
    });
    expect(rearmLeafAgentResume(tree, 1, "claude", 1234)).toBe(tree);
  });
});

function row(...ids: number[]): PaneNode {
  return {
    kind: "split",
    id: 100,
    dir: "row",
    children: ids.map((id) => ({ kind: "leaf", id })),
  };
}

function col(...ids: number[]): PaneNode {
  return {
    kind: "split",
    id: 200,
    dir: "col",
    children: ids.map((id) => ({ kind: "leaf", id })),
  };
}

describe("swapLeafInDirection", () => {
  it("swaps the active pane with its neighbor to the left", () => {
    expect(leafIds(swapLeafInDirection(row(1, 2, 3), 2, "left"))).toEqual([
      2, 1, 3,
    ]);
  });

  it("wraps right from the rightmost pane to the leftmost pane", () => {
    expect(leafIds(swapLeafInDirection(row(1, 2, 3), 3, "right"))).toEqual([
      3, 2, 1,
    ]);
  });

  it("swaps vertically and wraps upward", () => {
    expect(leafIds(swapLeafInDirection(col(1, 2, 3), 2, "down"))).toEqual([
      1, 3, 2,
    ]);
    expect(leafIds(swapLeafInDirection(col(1, 2, 3), 1, "up"))).toEqual([
      3, 2, 1,
    ]);
  });

  it("chooses the overlapping directional neighbor in a nested layout", () => {
    const tree: PaneNode = {
      kind: "split",
      id: 10,
      dir: "row",
      children: [
        { kind: "leaf", id: 1 },
        {
          kind: "split",
          id: 11,
          dir: "col",
          children: [
            { kind: "leaf", id: 2 },
            { kind: "leaf", id: 3 },
          ],
        },
      ],
    };

    expect(leafIds(swapLeafInDirection(tree, 2, "down"))).toEqual([1, 3, 2]);
    expect(leafIds(swapLeafInDirection(tree, 3, "left"))).toEqual([3, 2, 1]);
  });

  it("uses live pane bounds after splitters are resized", () => {
    const bounds = [
      { id: 1, left: 0, right: 100, top: 0, bottom: 100 },
      { id: 2, left: 200, right: 300, top: 100, bottom: 200 },
      { id: 3, left: 100, right: 200, top: 0, bottom: 100 },
    ];

    expect(
      leafIds(swapLeafInDirection(row(1, 2, 3), 1, "right", bounds)),
    ).toEqual([3, 2, 1]);
  });

  it("falls back to tree geometry when live bounds are incomplete", () => {
    const tree = row(1, 2, 3);
    const incompleteBounds = [
      { id: 1, left: 0, right: 100, top: 0, bottom: 100 },
    ];

    expect(
      leafIds(swapLeafInDirection(tree, 1, "right", incompleteBounds)),
    ).toEqual([2, 1, 3]);
  });

  it("moves pane metadata with the terminal session", () => {
    const tree: PaneNode = {
      kind: "split",
      id: 100,
      dir: "row",
      children: [
        { kind: "leaf", id: 1, cwd: "/one" },
        { kind: "leaf", id: 2, cwd: "/two" },
      ],
    };
    const swapped = swapLeafInDirection(tree, 2, "left");
    expect(swapped.kind).toBe("split");
    if (swapped.kind === "split") {
      expect(swapped.children[0]).toEqual({
        kind: "leaf",
        id: 2,
        slotId: 1,
        cwd: "/two",
      });
      expect(swapped.children[1]).toEqual({
        kind: "leaf",
        id: 1,
        slotId: 2,
        cwd: "/one",
      });
    }
  });

  it("keeps resizable layout slots fixed while sessions move", () => {
    const tree = row(1, 2, 3);
    const swapped = swapLeafInDirection(tree, 2, "left");

    expect(swapped.kind).toBe("split");
    if (swapped.kind === "split") {
      expect(swapped.children.map(firstLeafSlotId)).toEqual([1, 2, 3]);
      expect(leafIds(swapped)).toEqual([2, 1, 3]);
    }

    const restored = swapLeafInDirection(swapped, 2, "right");
    expect(restored.kind).toBe("split");
    if (restored.kind === "split") {
      expect(restored.children.map(firstLeafSlotId)).toEqual([1, 2, 3]);
      expect(leafIds(restored)).toEqual([1, 2, 3]);
    }
  });

  it("does nothing when the tree contains only one pane", () => {
    const tree: PaneNode = { kind: "leaf", id: 1 };
    expect(swapLeafInDirection(tree, 1, "left")).toBe(tree);
  });
});
