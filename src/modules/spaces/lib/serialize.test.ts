import type { Tab } from "@/modules/tabs/lib/useTabs";
import type { PaneNode } from "@/modules/terminal/lib/panes";
import { describe, expect, it } from "vitest";
import { hydrateTabs, type SerializedTab, serializeTabs } from "./serialize";

function counter(start = 100): () => number {
  let n = start;
  return () => n++;
}

function leafIdsOf(node: PaneNode): number[] {
  return node.kind === "leaf" ? [node.id] : node.children.flatMap(leafIdsOf);
}

function term(over: Partial<Extract<Tab, { kind: "terminal" }>>): Tab {
  return {
    id: 1,
    kind: "terminal",
    spaceId: "s1",
    title: "shell",
    paneTree: { kind: "leaf", id: 2, cwd: "/a" },
    activeLeafId: 2,
    ...over,
  } as Tab;
}

describe("serializeTabs", () => {
  it("drops private terminals and transient kinds", () => {
    const tabs: Tab[] = [
      term({ id: 1 }),
      term({ id: 3, private: true }),
      {
        id: 5,
        kind: "git-diff",
        spaceId: "s1",
        title: "d",
        path: "/a/x",
        repoRoot: "/a",
        mode: "+",
        originalPath: null,
        preview: true,
      },
      {
        id: 7,
        kind: "editor",
        spaceId: "s1",
        title: "x",
        path: "/a/x.ts",
        dirty: false,
        preview: false,
      },
    ];
    const out = serializeTabs(tabs);
    expect(out.map((t) => t.kind)).toEqual(["terminal", "editor"]);
  });

  it("marks the active leaf in a split tree", () => {
    const tree: PaneNode = {
      kind: "split",
      id: 10,
      dir: "row",
      children: [
        { kind: "leaf", id: 11, cwd: "/a" },
        { kind: "leaf", id: 12, cwd: "/b" },
      ],
    };
    const [s] = serializeTabs([term({ paneTree: tree, activeLeafId: 12 })]);
    const node = s as Extract<SerializedTab, { kind: "terminal" }>;
    expect(node.tree.kind).toBe("split");
    if (node.tree.kind === "split") {
      expect(node.tree.children[1]).toMatchObject({ cwd: "/b", active: true });
      expect(node.tree.children[0]).not.toHaveProperty("active");
    }
  });

  it("persists agent resume metadata without its runtime restore flag", () => {
    const [serialized] = serializeTabs([
      term({
        paneTree: {
          kind: "leaf",
          id: 2,
          cwd: "/a",
          agentResume: {
            agent: "claude",
            command: "claude --model opus",
            sessionId: "00000000-0000-4000-8000-000000000001",
            resumeOnStart: true,
          },
        },
      }),
    ]);
    expect(serialized).toMatchObject({
      kind: "terminal",
      tree: {
        agentResume: {
          agent: "claude",
          command: "claude --model opus",
          sessionId: "00000000-0000-4000-8000-000000000001",
        },
      },
    });
    expect(JSON.stringify(serialized)).not.toContain("resumeOnStart");
  });

  it("round-trips stable agent callsign metadata", () => {
    const [serialized] = serializeTabs([
      term({
        title: "Atlas",
        agent: {
          launcherId: "claude",
          icon: "claude",
          label: "Claude",
          name: "Atlas",
        },
      }),
    ]);
    expect(serialized).toMatchObject({
      kind: "terminal",
      agent: {
        launcherId: "claude",
        icon: "claude",
        label: "Claude",
        name: "Atlas",
      },
    });

    const [hydrated] = hydrateTabs([serialized], "s1", counter());
    expect(hydrated).toMatchObject({
      kind: "terminal",
      title: "Atlas",
      agent: {
        launcherId: "claude",
        icon: "claude",
        label: "Claude",
        name: "Atlas",
      },
    });
  });

  it("ignores malformed persisted agent identity metadata", () => {
    const serialized = {
      kind: "terminal",
      tree: { kind: "leaf", cwd: "/a" },
      agent: {
        launcherId: "claude",
        icon: "claude",
        label: "Claude",
        name: "Not a callsign",
      },
    } as unknown as SerializedTab;
    const [hydrated] = hydrateTabs([serialized], "s1", counter());
    expect(hydrated).not.toHaveProperty("agent");
    expect(hydrated).toMatchObject({ title: "a" });
  });

  it("repairs duplicate persisted callsigns within one workspace", () => {
    const identity = {
      launcherId: "claude" as const,
      icon: "claude" as const,
      label: "Claude",
      name: "Claude",
    };
    const restored = hydrateTabs(
      [
        { kind: "terminal", tree: { kind: "leaf" }, agent: identity },
        { kind: "terminal", tree: { kind: "leaf" }, agent: identity },
      ],
      "s1",
      counter(),
    );
    const names = restored.map((tab) =>
      tab.kind === "terminal" ? tab.agent?.name : undefined,
    );
    expect(names[0]).toBe("Claude");
    expect(names[1]).not.toBe("Claude");
    expect(names[1]).toMatch(/^[A-Za-z][A-Za-z0-9]{0,6}$/);
  });

  it("does not persist resume metadata before a real session id is discovered", () => {
    const [serialized] = serializeTabs([
      term({
        paneTree: {
          kind: "leaf",
          id: 2,
          agentResume: {
            agent: "claude",
            command: "claude",
            sessionId: "00000000-0000-4000-8000-000000000001",
            armed: false,
          },
        },
      }),
    ]);
    expect(JSON.stringify(serialized)).not.toContain("agentResume");
  });
});

describe("hydrateTabs", () => {
  it("round-trips structure, cwd, blocks and active leaf", () => {
    const tree: PaneNode = {
      kind: "split",
      id: 10,
      dir: "col",
      children: [
        { kind: "leaf", id: 11, cwd: "/a" },
        { kind: "leaf", id: 12, cwd: "/b" },
      ],
    };
    const tabs: Tab[] = [
      term({
        paneTree: tree,
        activeLeafId: 12,
        blocks: true,
        customTitle: "x",
      }),
    ];
    const serialized = serializeTabs(tabs);
    const [restored] = hydrateTabs(serialized, "s2", counter());
    expect(restored.kind).toBe("terminal");
    if (restored.kind !== "terminal") return;

    expect(restored.spaceId).toBe("s2");
    expect(restored.cold).toBe(true);
    expect(restored.blocks).toBe(true);
    expect(restored.customTitle).toBe("x");
    expect(restored.paneTree.kind).toBe("split");

    const leaves = leafIdsOf(restored.paneTree);
    expect(new Set(leaves).size).toBe(2);
    expect(leaves).toContain(restored.activeLeafId);
    // active leaf was the second one, which carried /b
    expect(restored.cwd).toBe("/b");
  });

  it("allocates fresh, unique, monotonic ids across all tabs and leaves", () => {
    const tree: PaneNode = {
      kind: "split",
      id: 10,
      dir: "row",
      children: [
        { kind: "leaf", id: 11, cwd: "/a" },
        { kind: "leaf", id: 12, cwd: "/b" },
      ],
    };
    const serialized = serializeTabs([
      term({ id: 1, paneTree: tree, activeLeafId: 11 }),
      term({ id: 2 }),
    ]);
    const restored = hydrateTabs(serialized, "s1", counter(100));

    const ids: number[] = [];
    for (const t of restored) {
      ids.push(t.id);
      if (t.kind === "terminal") ids.push(...leafIdsOf(t.paneTree));
    }
    expect(new Set(ids).size).toBe(ids.length);
    expect(Math.min(...ids)).toBeGreaterThanOrEqual(100);
  });

  it("restores per-leaf agent sessions and marks them for lazy resume", () => {
    const serialized: SerializedTab[] = [
      {
        kind: "terminal",
        tree: {
          kind: "split",
          dir: "row",
          children: [
            {
              kind: "leaf",
              cwd: "/a",
              agentResume: {
                agent: "claude",
                command: "claude",
                sessionId: "00000000-0000-4000-8000-000000000001",
              },
            },
            {
              kind: "leaf",
              cwd: "/b",
              agentResume: {
                agent: "pi",
                command: "pi",
                sessionId: "00000000-0000-4000-8000-000000000002",
              },
            },
          ],
        },
      },
    ];
    const [restored] = hydrateTabs(serialized, "s1", counter());
    expect(restored.kind).toBe("terminal");
    if (restored.kind !== "terminal" || restored.paneTree.kind !== "split") {
      return;
    }
    expect(
      restored.paneTree.children.map((node) =>
        node.kind === "leaf" ? node.agentResume : undefined,
      ),
    ).toEqual([
      {
        agent: "claude",
        command: "claude",
        sessionId: "00000000-0000-4000-8000-000000000001",
        armed: true,
        resumeOnStart: true,
      },
      {
        agent: "pi",
        command: "pi",
        sessionId: "00000000-0000-4000-8000-000000000002",
        armed: true,
        resumeOnStart: true,
      },
    ]);
  });

  it("ignores malformed agent resume metadata", () => {
    const serialized = [
      {
        kind: "terminal",
        tree: {
          kind: "leaf",
          agentResume: {
            agent: "claude",
            command: "claude",
            sessionId: "invalid",
          },
        },
      },
    ] as unknown as SerializedTab[];
    const [restored] = hydrateTabs(serialized, "s1", counter());
    expect(restored.kind).toBe("terminal");
    if (restored.kind === "terminal" && restored.paneTree.kind === "leaf") {
      expect(restored.paneTree.agentResume).toBeUndefined();
    }
  });

  it("returns empty for corrupted input without throwing", () => {
    expect(hydrateTabs([] as SerializedTab[], "s1", counter())).toEqual([]);
    expect(
      hydrateTabs(null as unknown as SerializedTab[], "s1", counter()),
    ).toEqual([]);
  });

  it("hydrates editor/browser/markdown as cold with derived titles", () => {
    const serialized: SerializedTab[] = [
      { kind: "editor", path: "/a/foo.ts" },
      { kind: "browser", url: "http://localhost:5173/x" },
      { kind: "markdown", path: "/a/README.md" },
    ];
    const out = hydrateTabs(serialized, "s1", counter());
    expect(out.every((t) => t.cold === true)).toBe(true);
    expect(out.map((t) => t.title)).toEqual([
      "foo.ts",
      "localhost:5173",
      "README.md",
    ]);
  });

  it("hydrates a blank browser tab with a capitalized default title", () => {
    const [restored] = hydrateTabs(
      [{ kind: "browser", url: "" }],
      "s1",
      counter(),
    );
    expect(restored?.title).toBe("Browser");
  });

  it('migrates legacy kind "preview" tabs to browser', () => {
    const serialized = [
      { kind: "preview", url: "http://localhost:3000" },
    ] as unknown as SerializedTab[];
    const [restored] = hydrateTabs(serialized, "s1", counter());
    expect(restored?.kind).toBe("browser");
    if (restored?.kind === "browser") {
      expect(restored.url).toBe("http://localhost:3000");
      expect(restored.title).toBe("localhost:3000");
    }
  });
});
