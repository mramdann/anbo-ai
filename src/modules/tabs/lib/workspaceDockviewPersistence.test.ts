import { describe, expect, it, vi } from "vitest";
import type { Tab, TerminalTab } from "./useTabs";
import { workspaceTabsToDockviewLayout } from "./workspaceDockviewLayout";
import {
  isWorkspaceDockviewLayoutForTabs,
  readWorkspaceDockviewLayout,
  workspaceDockviewLayoutIdentities,
  workspaceDockviewLayoutKey,
  writeWorkspaceDockviewLayout,
} from "./workspaceDockviewPersistence";

function terminalTab(id: number, cwd = `/tab/${id}`): TerminalTab {
  const leafId = id * 10 + 1;
  return {
    id,
    kind: "terminal",
    spaceId: "space",
    title: cwd,
    cwd,
    paneTree: { kind: "leaf", id: leafId, cwd },
    activeLeafId: leafId,
  };
}

function tabs(...ids: number[]): Tab[] {
  return ids.map((id) => terminalTab(id));
}

describe("workspace dockview persistence", () => {
  it("uses a versioned, space-specific key", () => {
    expect(workspaceDockviewLayoutKey("space/a b")).toBe(
      "anbo:workspace-dockview-layout:v1:space%2Fa%20b",
    );
  });

  it("accepts only layouts with exactly the current panel ids", () => {
    const layout = workspaceTabsToDockviewLayout([2, 7], 2);

    expect(isWorkspaceDockviewLayoutForTabs(layout, [7, 2])).toBe(true);
    expect(isWorkspaceDockviewLayoutForTabs(layout, [2])).toBe(false);
    expect(isWorkspaceDockviewLayoutForTabs(layout, [2, 7, 9])).toBe(false);
    expect(isWorkspaceDockviewLayoutForTabs(layout, [2, 2])).toBe(false);
  });

  it("rejects layouts with broken group panel references", () => {
    const layout = workspaceTabsToDockviewLayout([2, 7], 2);
    const root = layout.grid.root;
    if (!Array.isArray(root.data) || root.data[0]?.type !== "leaf") {
      throw new Error("expected workspace group");
    }
    const group = root.data[0].data as { views: string[] };
    group.views = ["tab:2", "tab:missing"];

    expect(isWorkspaceDockviewLayoutForTabs(layout, [2, 7])).toBe(false);
  });

  it("rejects layouts with a malformed root", () => {
    const layout = workspaceTabsToDockviewLayout([2], 2);
    layout.grid.root.type = "leaf";

    expect(isWorkspaceDockviewLayoutForTabs(layout, [2])).toBe(false);
  });

  it("returns null for corrupt, invalid, and mismatched saved layouts", () => {
    const getItem = vi
      .fn()
      .mockReturnValueOnce("not json")
      .mockReturnValueOnce(JSON.stringify({ panels: {} }))
      .mockReturnValueOnce(
        JSON.stringify(workspaceTabsToDockviewLayout([3], 3)),
      );
    const storage = { getItem, setItem: vi.fn() };

    expect(readWorkspaceDockviewLayout(storage, "one", tabs(3))).toBeNull();
    expect(readWorkspaceDockviewLayout(storage, "one", tabs(3))).toBeNull();
    expect(readWorkspaceDockviewLayout(storage, "one", tabs(4))).toBeNull();
  });

  it("writes serialized layouts and tolerates storage failures", () => {
    const layout = workspaceTabsToDockviewLayout([4], 4);
    const storage = {
      getItem: vi.fn(),
      setItem: vi.fn(() => {
        throw new Error("quota");
      }),
    };

    expect(() =>
      writeWorkspaceDockviewLayout(storage, "space", layout, tabs(4)),
    ).not.toThrow();
    expect(storage.setItem).toHaveBeenCalledWith(
      workspaceDockviewLayoutKey("space"),
      expect.stringContaining('"runtimeTabIds":[4]'),
    );
    expect(storage.setItem).toHaveBeenCalledWith(
      workspaceDockviewLayoutKey("space"),
      expect.stringContaining('"layoutIdentities":['),
    );
    expect(storage.setItem).toHaveBeenCalledWith(
      workspaceDockviewLayoutKey("space"),
      expect.stringContaining('"slot:0"'),
    );
  });

  it("returns a partial layout when a tab is added while inactive", () => {
    let saved: string | null = null;
    const storage = {
      getItem: vi.fn(() => saved),
      setItem: vi.fn((_key: string, value: string) => {
        saved = value;
      }),
    };
    writeWorkspaceDockviewLayout(
      storage,
      "space",
      workspaceTabsToDockviewLayout([4, 9], 9),
      tabs(4, 9),
    );

    const restored = readWorkspaceDockviewLayout(
      storage,
      "space",
      tabs(4, 9, 12),
    );
    expect(Object.keys(restored?.panels ?? {})).toEqual(["tab:4", "tab:9"]);
    expect(restored?.grid.root.data).toMatchObject([
      { data: { views: ["tab:4", "tab:9"], activeView: "tab:9" } },
    ]);
  });

  it("drops removed tabs while preserving split geometry and empty groups", () => {
    let saved: string | null = null;
    const storage = {
      getItem: vi.fn(() => saved),
      setItem: vi.fn((_key: string, value: string) => {
        saved = value;
      }),
    };
    const layout = workspaceTabsToDockviewLayout([4, 9], 9);
    layout.grid.root.data = [
      {
        type: "leaf",
        size: 600,
        data: { id: "left", views: ["tab:4"], activeView: "tab:4" },
      },
      {
        type: "leaf",
        size: 400,
        data: { id: "right", views: ["tab:9"], activeView: "tab:9" },
      },
    ];
    writeWorkspaceDockviewLayout(storage, "space", layout, tabs(4, 9));

    const restored = readWorkspaceDockviewLayout(storage, "space", tabs(4));
    expect(Object.keys(restored?.panels ?? {})).toEqual(["tab:4"]);
    expect(restored?.grid.root.data).toEqual([
      {
        type: "leaf",
        size: 600,
        data: { id: "left", views: ["tab:4"], activeView: "tab:4" },
      },
      {
        type: "leaf",
        size: 400,
        data: { id: "right", views: [] },
      },
    ]);
  });

  it("keeps saved panel identities through a same-process reorder", () => {
    let saved: string | null = null;
    const storage = {
      getItem: vi.fn(() => saved),
      setItem: vi.fn((_key: string, value: string) => {
        saved = value;
      }),
    };
    writeWorkspaceDockviewLayout(
      storage,
      "space",
      workspaceTabsToDockviewLayout([4, 9], 9),
      tabs(4, 9),
    );

    const restored = readWorkspaceDockviewLayout(storage, "space", tabs(9, 4));
    expect(restored?.grid.root.data).toMatchObject([
      { data: { views: ["tab:4", "tab:9"], activeView: "tab:9" } },
    ]);
    expect(restored?.panels["tab:4"]?.params).toMatchObject({ tabId: 4 });
    expect(restored?.panels["tab:9"]?.params).toMatchObject({ tabId: 9 });
  });

  it("remaps persisted slots to fresh runtime tab ids after restart", () => {
    let saved: string | null = null;
    const storage = {
      getItem: vi.fn(() => saved),
      setItem: vi.fn((_key: string, value: string) => {
        saved = value;
      }),
    };
    writeWorkspaceDockviewLayout(
      storage,
      "space",
      workspaceTabsToDockviewLayout([4, 9], 9),
      [terminalTab(4, "/one"), terminalTab(9, "/two")],
    );

    const restored = readWorkspaceDockviewLayout(storage, "space", [
      terminalTab(40, "/one"),
      terminalTab(90, "/two"),
    ]);
    expect(Object.keys(restored?.panels ?? {})).toEqual(["tab:40", "tab:90"]);
    expect(restored?.panels["tab:90"]?.params).toMatchObject({ tabId: 90 });
  });

  it("restores stable tabs after restart when persisted tabs are added or removed", () => {
    let saved: string | null = null;
    const storage = {
      getItem: vi.fn(() => saved),
      setItem: vi.fn((_key: string, value: string) => {
        saved = value;
      }),
    };
    const layout = workspaceTabsToDockviewLayout([4, 9], 9);
    layout.grid.root.data = [
      {
        type: "leaf",
        size: 600,
        data: { id: "left", views: ["tab:4"], activeView: "tab:4" },
      },
      {
        type: "leaf",
        size: 400,
        data: { id: "right", views: ["tab:9"], activeView: "tab:9" },
      },
    ];
    writeWorkspaceDockviewLayout(storage, "space", layout, [
      terminalTab(4, "/one"),
      terminalTab(9, "/two"),
    ]);

    const withAddedTab = readWorkspaceDockviewLayout(storage, "space", [
      terminalTab(40, "/one"),
      terminalTab(90, "/two"),
      terminalTab(120, "/three"),
    ]);
    expect(Object.keys(withAddedTab?.panels ?? {})).toEqual([
      "tab:40",
      "tab:90",
    ]);
    expect(withAddedTab?.grid.root.data).toEqual([
      {
        type: "leaf",
        size: 600,
        data: { id: "left", views: ["tab:40"], activeView: "tab:40" },
      },
      {
        type: "leaf",
        size: 400,
        data: { id: "right", views: ["tab:90"], activeView: "tab:90" },
      },
    ]);

    const withRemovedTab = readWorkspaceDockviewLayout(storage, "space", [
      terminalTab(90, "/two"),
    ]);
    expect(Object.keys(withRemovedTab?.panels ?? {})).toEqual(["tab:90"]);
    expect(withRemovedTab?.grid.root.data).toEqual([
      {
        type: "leaf",
        size: 600,
        data: { id: "left", views: [] },
      },
      {
        type: "leaf",
        size: 400,
        data: { id: "right", views: ["tab:90"], activeView: "tab:90" },
      },
    ]);
  });

  it("disambiguates duplicate terminal identities by occurrence", () => {
    let saved: string | null = null;
    const storage = {
      getItem: vi.fn(() => saved),
      setItem: vi.fn((_key: string, value: string) => {
        saved = value;
      }),
    };
    const layout = workspaceTabsToDockviewLayout([4, 9], 9);
    layout.grid.root.data = [
      {
        type: "leaf",
        data: { id: "left", views: ["tab:4"], activeView: "tab:4" },
      },
      {
        type: "leaf",
        data: { id: "right", views: ["tab:9"], activeView: "tab:9" },
      },
    ];
    const original = [terminalTab(4, "/same"), terminalTab(9, "/same")];
    const restarted = [terminalTab(40, "/same"), terminalTab(90, "/same")];
    expect(workspaceDockviewLayoutIdentities(original)[0]).toBe(
      workspaceDockviewLayoutIdentities(restarted)[0],
    );
    expect(new Set(workspaceDockviewLayoutIdentities(original)).size).toBe(2);
    writeWorkspaceDockviewLayout(storage, "space", layout, original);

    const restored = readWorkspaceDockviewLayout(storage, "space", restarted);
    expect(restored?.grid.root.data).toEqual([
      {
        type: "leaf",
        data: { id: "left", views: ["tab:40"], activeView: "tab:40" },
      },
      {
        type: "leaf",
        data: { id: "right", views: ["tab:90"], activeView: "tab:90" },
      },
    ]);
  });

  it("drops a nonserializable saved tab after restart", () => {
    let saved: string | null = null;
    const storage = {
      getItem: vi.fn(() => saved),
      setItem: vi.fn((_key: string, value: string) => {
        saved = value;
      }),
    };
    const transient: Tab = {
      id: 9,
      kind: "ai-diff",
      spaceId: "space",
      title: "change.ts",
      path: "/change.ts",
      originalContent: "old",
      proposedContent: "new",
      approvalId: "approval",
      status: "pending",
      isNewFile: false,
    };
    const layout = workspaceTabsToDockviewLayout([4, 9], 4);
    layout.grid.root.data = [
      {
        type: "leaf",
        size: 700,
        data: { id: "main", views: ["tab:4"], activeView: "tab:4" },
      },
      {
        type: "leaf",
        size: 300,
        data: { id: "diff", views: ["tab:9"], activeView: "tab:9" },
      },
    ];
    writeWorkspaceDockviewLayout(storage, "space", layout, [
      terminalTab(4, "/shell"),
      transient,
    ]);

    const restored = readWorkspaceDockviewLayout(storage, "space", [
      terminalTab(40, "/shell"),
    ]);
    expect(Object.keys(restored?.panels ?? {})).toEqual(["tab:40"]);
    expect(restored?.grid.root.data).toEqual([
      {
        type: "leaf",
        size: 700,
        data: { id: "main", views: ["tab:40"], activeView: "tab:40" },
      },
      {
        type: "leaf",
        size: 300,
        data: { id: "diff", views: [] },
      },
    ]);
  });

  it("reads the previous runtime-id envelope when positional mapping is safe", () => {
    let saved: string | null = null;
    const writer = {
      getItem: vi.fn(),
      setItem: vi.fn((_key: string, value: string) => {
        saved = value;
      }),
    };
    writeWorkspaceDockviewLayout(
      writer,
      "space",
      workspaceTabsToDockviewLayout([4, 9], 9),
      tabs(4, 9),
    );
    const legacyEnvelope = JSON.parse(saved ?? "null") as {
      layoutIdentities?: unknown;
    };
    delete legacyEnvelope.layoutIdentities;
    const storage = {
      getItem: vi.fn(() => JSON.stringify(legacyEnvelope)),
      setItem: vi.fn(),
    };

    expect(
      Object.keys(
        readWorkspaceDockviewLayout(storage, "space", tabs(40, 90))?.panels ??
          {},
      ),
    ).toEqual(["tab:40", "tab:90"]);
    expect(readWorkspaceDockviewLayout(storage, "space", tabs(40))).toBeNull();
  });

  it("reads the previous bare slot layout only when counts match", () => {
    let saved: string | null = null;
    const writer = {
      getItem: vi.fn(),
      setItem: vi.fn((_key: string, value: string) => {
        saved = value;
      }),
    };
    writeWorkspaceDockviewLayout(
      writer,
      "space",
      workspaceTabsToDockviewLayout([4, 9], 9),
      tabs(4, 9),
    );
    const envelope = JSON.parse(saved ?? "null") as { layout: unknown };
    const storage = {
      getItem: vi.fn(() => JSON.stringify(envelope.layout)),
      setItem: vi.fn(),
    };

    expect(
      Object.keys(
        readWorkspaceDockviewLayout(storage, "space", tabs(40, 90))?.panels ??
          {},
      ),
    ).toEqual(["tab:40", "tab:90"]);
    expect(readWorkspaceDockviewLayout(storage, "space", tabs(40))).toBeNull();
  });

  it("rejects malformed saved references and roots before remapping", () => {
    let saved: string | null = null;
    const storage = {
      getItem: vi.fn(() => saved),
      setItem: vi.fn((_key: string, value: string) => {
        saved = value;
      }),
    };
    writeWorkspaceDockviewLayout(
      storage,
      "space",
      workspaceTabsToDockviewLayout([4, 9], 9),
      tabs(4, 9),
    );
    const valid = saved ?? "";
    const brokenReferences = JSON.parse(valid) as {
      layout: {
        grid: { root: { data: Array<{ data: { views: string[] } }> } };
      };
    };
    brokenReferences.layout.grid.root.data[0].data.views = [
      "slot:0",
      "slot:missing",
    ];
    saved = JSON.stringify(brokenReferences);
    expect(
      readWorkspaceDockviewLayout(storage, "space", tabs(4, 9)),
    ).toBeNull();

    const brokenRoot = JSON.parse(valid) as {
      layout: { grid: { root: { type: string } } };
    };
    brokenRoot.layout.grid.root.type = "leaf";
    saved = JSON.stringify(brokenRoot);
    expect(
      readWorkspaceDockviewLayout(storage, "space", tabs(4, 9)),
    ).toBeNull();

    const brokenIdentities = JSON.parse(valid) as {
      layoutIdentities: string[];
    };
    brokenIdentities.layoutIdentities[0] = "not an identity";
    saved = JSON.stringify(brokenIdentities);
    expect(
      readWorkspaceDockviewLayout(storage, "space", tabs(4, 9)),
    ).toBeNull();
  });
});
