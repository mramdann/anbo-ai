import { describe, expect, it } from "vitest";
import { dockviewLayoutKey, paneTreeToDockviewLayout } from "./dockviewLayout";
import type { PaneNode } from "./panes";

describe("paneTreeToDockviewLayout", () => {
  it("wraps one terminal in the branch root required by Dockview", () => {
    const layout = paneTreeToDockviewLayout(
      { kind: "leaf", id: 7, cwd: "/tmp" },
      7,
    );

    expect(layout.grid.orientation).toBe("HORIZONTAL");
    expect(layout.grid.root.type).toBe("branch");
    expect(layout.grid.root.data).toHaveLength(1);
    expect(layout.panels["terminal:7"]).toMatchObject({
      id: "terminal:7",
      contentComponent: "terminal",
      params: { leafId: 7 },
    });
    expect(layout.activeGroup).toBe("terminal-group:7");
  });

  it("serializes nested row and column splits", () => {
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

    const layout = paneTreeToDockviewLayout(tree, 3);
    expect(layout.grid.orientation).toBe("HORIZONTAL");
    expect(layout.grid.root.type).toBe("branch");
    if (!Array.isArray(layout.grid.root.data)) return;
    expect(layout.grid.root.data.map((node) => node.type)).toEqual([
      "leaf",
      "branch",
    ]);
    expect(layout.activeGroup).toBe("terminal-group:3");
    expect(Object.keys(layout.panels)).toEqual([
      "terminal:1",
      "terminal:2",
      "terminal:3",
    ]);
  });

  it("flattens nested splits that use the same direction", () => {
    const tree: PaneNode = {
      kind: "split",
      id: 10,
      dir: "row",
      children: [
        { kind: "leaf", id: 1 },
        {
          kind: "split",
          id: 11,
          dir: "row",
          children: [
            { kind: "leaf", id: 2 },
            { kind: "leaf", id: 3 },
          ],
        },
      ],
    };

    const layout = paneTreeToDockviewLayout(tree);
    expect(layout.grid.root.type).toBe("branch");
    if (!Array.isArray(layout.grid.root.data)) return;
    expect(layout.grid.root.data.map((node) => node.type)).toEqual([
      "leaf",
      "leaf",
      "leaf",
    ]);
    expect(layout.grid.root.data.map((node) => node.size)).toEqual([
      500, 250, 250,
    ]);
  });

  it("distinguishes nested proportions from an equal flat split", () => {
    const flat: PaneNode = {
      kind: "split",
      id: 10,
      dir: "row",
      children: [1, 2, 3].map((id) => ({ kind: "leaf", id })),
    };
    const nested: PaneNode = {
      kind: "split",
      id: 11,
      dir: "row",
      children: [
        { kind: "leaf", id: 1 },
        {
          kind: "split",
          id: 12,
          dir: "row",
          children: [
            { kind: "leaf", id: 2 },
            { kind: "leaf", id: 3 },
          ],
        },
      ],
    };

    expect(dockviewLayoutKey(nested)).not.toBe(dockviewLayoutKey(flat));
  });

  it("keeps layout identity stable across cwd updates", () => {
    expect(
      dockviewLayoutKey({ kind: "leaf", id: 1, slotId: 9, cwd: "/one" }),
    ).toBe(dockviewLayoutKey({ kind: "leaf", id: 1, slotId: 9, cwd: "/two" }));
  });

  it("uses slot identity for groups while panel identity follows the PTY", () => {
    const layout = paneTreeToDockviewLayout({
      kind: "leaf",
      id: 42,
      slotId: 5,
    });
    expect(layout.activeGroup).toBe("terminal-group:5");
    expect(Object.keys(layout.panels)).toEqual(["terminal:42"]);
  });
});
