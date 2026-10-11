import { beforeEach, describe, expect, it, vi } from "vitest";

const kept = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
  sets: 0,
  saves: 0,
  failEntries: false,
  // How long each next set takes, in ms, so a test can finish them out of turn.
  delays: [] as number[],
}));

vi.mock("@/lib/localStore", () => ({
  LocalLazyStore: class {
    async entries() {
      if (kept.failEntries) throw new Error("store unavailable");
      return [...kept.store.entries()];
    }
    async set(key: string, value: unknown) {
      kept.sets += 1;
      const delay = kept.delays.shift() ?? 0;
      await new Promise((resolve) => setTimeout(resolve, delay));
      kept.store.set(key, value);
    }
    async save() {
      kept.saves += 1;
    }
  },
}));

const layoutKey = "anbo:workspace-dockview-layout:v1:sp-a";
const local = new Map<string, string>();

beforeEach(() => {
  vi.resetModules();
  kept.store.clear();
  kept.sets = 0;
  kept.saves = 0;
  kept.failEntries = false;
  kept.delays = [];
  local.clear();
  vi.stubGlobal("window", {
    localStorage: {
      get length() {
        return local.size;
      },
      key: (index: number) => [...local.keys()][index] ?? null,
      getItem: (key: string) => local.get(key) ?? null,
      setItem: (key: string, value: string) => local.set(key, value),
      removeItem: (key: string) => local.delete(key),
    },
  });
});

const layouts = () => import("./workspaceLayoutStore");

describe("workspace layout store", () => {
  it("keeps layouts in the app's store, never in localStorage", async () => {
    // Every localStorage write reaches each window of the origin, and the
    // orb's renderer kept what it was handed.
    const {
      loadWorkspaceLayouts,
      saveWorkspaceLayouts,
      workspaceLayoutStorage,
    } = await layouts();
    await loadWorkspaceLayouts();
    workspaceLayoutStorage.setItem(layoutKey, '{"layout":1}');
    expect(workspaceLayoutStorage.getItem(layoutKey)).toBe('{"layout":1}');
    await saveWorkspaceLayouts();
    expect(kept.store.get(layoutKey)).toBe('{"layout":1}');
    expect(kept.saves).toBe(1);
    expect(local.size).toBe(0);
  });

  it("moves the layouts an older version kept in localStorage, once", async () => {
    local.set(layoutKey, '{"old":1}');
    local.set("anbo-sidebar-width", "280");
    const first = await layouts();
    await first.loadWorkspaceLayouts();
    await first.saveWorkspaceLayouts();
    expect(first.workspaceLayoutStorage.getItem(layoutKey)).toBe('{"old":1}');
    expect(kept.store.get(layoutKey)).toBe('{"old":1}');
    expect([...local.keys()]).toEqual(["anbo-sidebar-width"]);
    // A store that already holds the layout wins over a leftover key.
    local.set(layoutKey, '{"leftover":1}');
    vi.resetModules();
    const again = await layouts();
    await again.loadWorkspaceLayouts();
    expect(again.workspaceLayoutStorage.getItem(layoutKey)).toBe('{"old":1}');
    expect(local.has(layoutKey)).toBe(false);
  });

  it("leaves the old copy in place while the store does not answer", async () => {
    local.set(layoutKey, '{"old":1}');
    kept.failEntries = true;
    const { loadWorkspaceLayouts, workspaceLayoutStorage } = await layouts();
    await loadWorkspaceLayouts();
    expect(workspaceLayoutStorage.getItem(layoutKey)).toBe('{"old":1}');
    expect(local.get(layoutKey)).toBe('{"old":1}');
  });

  it("drops a write made before the kept layouts arrived", async () => {
    kept.store.set(layoutKey, '{"kept":1}');
    const {
      loadWorkspaceLayouts,
      saveWorkspaceLayouts,
      workspaceLayoutStorage,
    } = await layouts();
    workspaceLayoutStorage.setItem(layoutKey, '{"made without them":1}');
    expect(workspaceLayoutStorage.getItem(layoutKey)).toBeNull();
    await loadWorkspaceLayouts();
    await saveWorkspaceLayouts();
    expect(workspaceLayoutStorage.getItem(layoutKey)).toBe('{"kept":1}');
    expect(kept.store.get(layoutKey)).toBe('{"kept":1}');
    expect(kept.sets).toBe(0);
  });

  it("writes a layout only when it changed, and the last one given wins", async () => {
    const {
      loadWorkspaceLayouts,
      saveWorkspaceLayouts,
      workspaceLayoutStorage,
    } = await layouts();
    await loadWorkspaceLayouts();
    // The first write takes longer than the second; it must still land first.
    kept.delays = [30, 0];
    workspaceLayoutStorage.setItem(layoutKey, '{"first":1}');
    workspaceLayoutStorage.setItem(layoutKey, '{"second":1}');
    workspaceLayoutStorage.setItem(layoutKey, '{"second":1}');
    await saveWorkspaceLayouts();
    expect(kept.sets).toBe(2);
    expect(kept.store.get(layoutKey)).toBe('{"second":1}');
  });
});
