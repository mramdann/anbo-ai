import {
  type ExternalBrowser,
  type ExternalConnection,
  savedExternalBrowser,
} from "@/modules/browser/external/model";
import {
  createExternalBrowserSync,
  openExternalBrowser,
} from "@/modules/browser/external/sync";
import type { BrowserTab, Tab, TabPatch } from "@/modules/tabs/lib/useTabs";
import { invoke } from "@tauri-apps/api/core";
import { describe, expect, it, vi } from "vitest";

// The service under test takes its own `call`; only the opens made before
// any service runs reach this mock.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const profile = {
  profileId: "00112233-4455-6677-8899-aabbccddeeff",
  browser: "chrome" as const,
  name: "Work",
};
const connection = (): ExternalConnection => ({
  connectionId: "session",
  profile,
  workspace: "D:/work",
  tabs: [
    {
      id: 10,
      title: "Example",
      url: "https://example.com/",
      selectionId: "lease",
      loading: false,
    },
  ],
});

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<Value>((accepted, refused) => {
    resolve = accepted;
    reject = refused;
  });
  return { promise, resolve, reject };
}

function harness(initial: Tab[] = []) {
  let tabs = initial;
  let spaces: { id: string; root: string | null }[] = [
    { id: "work", root: "d:\\work" },
    { id: "other", root: "D:/other" },
    { id: "empty", root: null },
  ];
  let connections = [connection()];
  let nextId = 100;
  const calls = vi.fn(async (command: string) => {
    if (command === "browser_external_connections") return connections;
    if (command === "browser_external_open_tab") return connections[0].tabs[0];
    return undefined;
  });
  const create = vi.fn(
    (
      url: string,
      _activate: boolean,
      spaceId: string,
      external: ExternalBrowser,
    ) => {
      const id = nextId++;
      tabs = [
        ...tabs,
        { id, kind: "browser", url, title: url, spaceId, external },
      ];
      return id;
    },
  );
  const update = (id: number, patch: TabPatch) => {
    tabs = tabs.map((tab) =>
      tab.id === id ? ({ ...tab, ...patch } as Tab) : tab,
    );
  };
  const warm = vi.fn((id: number) => {
    tabs = tabs.map((tab) => (tab.id === id ? { ...tab, cold: false } : tab));
  });
  const service = createExternalBrowserSync(
    {
      tabs: () => tabs,
      spaces: () => spaces,
      create,
      update,
      warm,
    },
    calls as typeof invoke,
  );
  return {
    service,
    calls,
    create,
    warm,
    tabs: () => tabs as BrowserTab[],
    connections: (next: ExternalConnection[]) => {
      connections = next;
    },
    setTabs: (next: Tab[]) => {
      tabs = next;
    },
    setSpaces: (next: typeof spaces) => {
      spaces = next;
    },
  };
}

describe("external browser workspace synchronization", () => {
  it.each(["resolve", "reject"] as const)(
    "does not reconnect a moved panel when its old binding finishes late: %s",
    async (outcome) => {
      const state = harness();
      const started = deferred<void>();
      const pending = deferred<void>();
      state.calls.mockImplementation(async (command) => {
        if (command === "browser_external_connections") return [connection()];
        if (command === "browser_external_bind") {
          started.resolve();
          await pending.promise;
        }
      });
      const refresh = state.service.refresh();
      await started.promise;
      state.service.reconcile();
      state.setTabs([{ ...state.tabs()[0], spaceId: "other" }]);
      if (outcome === "resolve") pending.resolve();
      else pending.reject(new Error("Old binding failed"));
      await refresh;
      expect(state.tabs()[0]).toMatchObject({
        spaceId: "other",
        external: {
          connected: false,
          error: expect.stringContaining("destination workspace"),
        },
      });
      expect(state.warm).not.toHaveBeenCalled();
      expect(state.calls).toHaveBeenCalledWith("browser_external_unbind", {
        tabId: 100,
        connectionId: "session",
        selectionId: "lease",
        forget: false,
      });
    },
  );

  it("does not warm a closed panel after its binding completes", async () => {
    const state = harness();
    const started = deferred<void>();
    const pending = deferred<void>();
    state.calls.mockImplementation(async (command) => {
      if (command === "browser_external_connections") return [connection()];
      if (command === "browser_external_bind") {
        started.resolve();
        await pending.promise;
      }
    });
    const refresh = state.service.refresh();
    await started.promise;
    state.service.reconcile();
    state.setTabs([]);
    state.service.reconcile();
    pending.resolve();
    await refresh;
    expect(state.tabs()).toEqual([]);
    expect(state.warm).not.toHaveBeenCalled();
    expect(state.calls).toHaveBeenCalledWith("browser_external_unbind", {
      tabId: 100,
      connectionId: "session",
      selectionId: "lease",
      forget: true,
    });
  });

  it("does not publish a late binding or open another tab after stopping", async () => {
    const state = harness();
    const started = deferred<void>();
    const pending = deferred<void>();
    state.calls.mockImplementation(async (command) => {
      if (command === "browser_external_connections") return [connection()];
      if (command === "browser_external_bind") {
        started.resolve();
        await pending.promise;
      }
    });
    const refresh = state.service.refresh();
    await started.promise;
    state.service.stop();
    pending.resolve();
    await refresh;
    expect(state.tabs()[0].external?.connected).toBe(false);
    expect(state.warm).not.toHaveBeenCalled();
    state.calls.mockClear();
    await expect(
      state.service.open("https://example.org/", "D:/work"),
    ).rejects.toThrow("stopped");
    expect(state.calls).not.toHaveBeenCalled();
  });

  it("drains a metadata change arriving during refresh promise completion", async () => {
    const state = harness();
    let queued: Promise<void> | undefined;
    state.warm.mockImplementationOnce(() => {
      queueMicrotask(() => {
        queueMicrotask(() => {
          state.connections([
            {
              ...connection(),
              tabs: [{ ...connection().tabs[0], title: "Latest metadata" }],
            },
          ]);
          queued = state.service.refresh();
        });
      });
    });
    await state.service.refresh();
    await queued;
    expect(queued).toBeDefined();
    expect(state.tabs()[0].title).toBe("Latest metadata");
    expect(state.create).toHaveBeenCalledTimes(1);
    expect(
      state.calls.mock.calls.filter(
        ([command]) => command === "browser_external_connections",
      ),
    ).toHaveLength(2);
  });

  it("does not dispatch open after stopping during the connection read", async () => {
    const state = harness();
    const pending = deferred<ExternalConnection[]>();
    state.calls.mockImplementationOnce(() => pending.promise);
    const opening = state.service.open("https://example.org/", "D:/work");
    // Opens are queued, so the read starts a moment later.
    await vi.waitFor(() => expect(state.calls).toHaveBeenCalledTimes(1));
    state.service.stop();
    pending.resolve([connection()]);
    await expect(opening).rejects.toThrow("stopped");
    expect(state.calls).toHaveBeenCalledTimes(1);
    expect(state.create).not.toHaveBeenCalled();
  });

  it("does not repeat or refresh a dispatched open after stopping", async () => {
    const state = harness();
    const started = deferred<void>();
    const pending = deferred<ExternalConnection["tabs"][number]>();
    state.calls.mockImplementation(async (command) => {
      if (command === "browser_external_connections") return [connection()];
      if (command === "browser_external_open_tab") {
        started.resolve();
        return pending.promise;
      }
    });
    const opening = state.service.open("https://example.org/", "D:/work");
    await started.promise;
    state.service.stop();
    const callsBeforeReply = state.calls.mock.calls.length;
    pending.resolve(connection().tabs[0]);
    await expect(opening).rejects.toThrow("stopped");
    expect(state.calls).toHaveBeenCalledTimes(callsBeforeReply);
  });

  it("does not unbind from a stale reconciliation after stopping", async () => {
    const state = harness();
    await state.service.refresh();
    state.service.reconcile();
    state.service.stop();
    state.calls.mockClear();
    state.setTabs([]);
    state.service.reconcile();
    await state.service.refresh();
    expect(state.calls).not.toHaveBeenCalled();
  });

  it("retains all ten workspace selections across foreground changes without rebinding or focusing", async () => {
    const state = harness();
    const spaces = Array.from({ length: 10 }, (_, index) => ({
      id: `space-${index}`,
      root: `D:/workspace-${index}`,
    }));
    const connections = spaces.map((space, index) => ({
      ...connection(),
      connectionId: `connection-${index}`,
      workspace: space.root,
      tabs: [{ ...connection().tabs[0], selectionId: `lease-${index}` }],
    }));
    state.setSpaces(spaces);
    state.connections(connections);
    await state.service.refresh();
    state.service.reconcile();
    const identities = state.tabs().map((tab) => ({
      id: tab.id,
      spaceId: tab.spaceId,
      selectionId: tab.external?.selectionId,
    }));
    for (let active = 0; active < spaces.length; active += 1) {
      state.setSpaces([
        spaces[active],
        ...spaces.filter((_, index) => index !== active),
      ]);
      state.connections(
        connections.map((connection) => ({
          ...connection,
          tabs: connection.tabs.map((tab) => ({
            ...tab,
            title: `Background action ${active}`,
          })),
        })),
      );
      state.service.reconcile();
      await state.service.refresh();
      expect(state.tabs().every((tab) => tab.external?.connected)).toBe(true);
      expect(
        state.tabs().map((tab) => ({
          id: tab.id,
          spaceId: tab.spaceId,
          selectionId: tab.external?.selectionId,
        })),
      ).toEqual(identities);
    }
    expect(state.create).toHaveBeenCalledTimes(10);
    expect(state.create.mock.calls.every((args) => args[1] === false)).toBe(
      true,
    );
    expect(
      state.calls.mock.calls.filter(
        ([command]) => command === "browser_external_bind",
      ),
    ).toHaveLength(10);
    expect(
      state.calls.mock.calls.some(
        ([command]) => command === "browser_external_unbind",
      ),
    ).toBe(false);
  });

  it("never guesses between two restored panels with the same URL", async () => {
    const saved: BrowserTab = {
      id: 7,
      kind: "browser",
      spaceId: "work",
      url: "https://example.com/",
      title: "Saved",
      layoutKey: "first",
      external: profile,
    };
    const state = harness([saved, { ...saved, id: 8, layoutKey: "second" }]);
    await state.service.refresh();
    expect(state.create).toHaveBeenCalledTimes(1);
    expect(
      state
        .tabs()
        .slice(0, 2)
        .map((tab) => tab.layoutKey),
    ).toEqual(["first", "second"]);
    expect(
      state
        .tabs()
        .slice(0, 2)
        .every((tab) => !tab.external?.connected),
    ).toBe(true);
  });
  it("reuses the saved panel when disconnect and reconnect events are coalesced", async () => {
    const state = harness();
    await state.service.refresh();
    state.service.reconcile();
    const id = state.tabs()[0].id;
    state.connections([
      {
        ...connection(),
        connectionId: "reconnected",
        tabs: [{ ...connection().tabs[0], selectionId: "new-lease" }],
      },
    ]);
    await state.service.refresh();
    expect(state.create).toHaveBeenCalledTimes(1);
    expect(state.tabs()[0]).toMatchObject({
      id,
      external: {
        connectionId: "reconnected",
        selectionId: "new-lease",
        connected: true,
      },
    });
    state.service.reconcile();
    state.setTabs([]);
    state.service.reconcile();
    expect(state.calls).toHaveBeenLastCalledWith("browser_external_unbind", {
      tabId: id,
      connectionId: "reconnected",
      selectionId: "new-lease",
      forget: true,
    });
  });

  it("creates a real Anbo tab in the approved workspace without activating it", async () => {
    const state = harness();
    await state.service.refresh();
    expect(state.create).toHaveBeenCalledWith(
      "https://example.com/",
      false,
      "work",
      expect.any(Object),
    );
    expect(state.tabs()[0].external?.connected).toBe(true);
    expect(state.calls).toHaveBeenCalledWith("browser_external_bind", {
      binding: expect.objectContaining({
        tabId: 100,
        browserTabId: 10,
        workspace: "D:/work",
        selectionId: "lease",
      }),
    });
    state.connections([
      {
        ...connection(),
        tabs: [{ ...connection().tabs[0], title: "Updated", loading: true }],
      },
    ]);
    await state.service.refresh();
    expect(state.create).toHaveBeenCalledTimes(1);
    expect(state.tabs()[0]).toMatchObject({
      id: 100,
      title: "Updated",
      loading: true,
    });
  });

  it("keeps restored layout identity and never restores a live lease from disk", async () => {
    const saved: BrowserTab = {
      id: 7,
      kind: "browser",
      spaceId: "work",
      url: "https://example.com/",
      title: "Saved",
      layoutKey: "original-panel",
      cold: true,
      external: profile,
    };
    const state = harness([saved]);
    await state.service.refresh();
    expect(state.create).not.toHaveBeenCalled();
    expect(state.tabs()[0]).toMatchObject({
      id: 7,
      layoutKey: "original-panel",
      cold: false,
    });
    expect(savedExternalBrowser(state.tabs()[0].external)).toEqual(profile);
    state.connections([]);
    await state.service.refresh();
    expect(state.tabs()[0].external?.connected).toBe(false);
    await expect(
      state.service.open("https://example.org", "D:/work"),
    ).rejects.toThrow("will not fall back");
  });

  it("does not recreate a closed tab from an in-flight metadata update", async () => {
    const state = harness();
    await state.service.refresh();
    state.service.reconcile();
    state.setTabs([]);
    state.service.reconcile();
    await state.service.refresh();
    expect(state.create).toHaveBeenCalledTimes(1);
    expect(state.calls).toHaveBeenCalledWith("browser_external_unbind", {
      tabId: 100,
      connectionId: "session",
      selectionId: "lease",
      forget: true,
    });
  });

  it("disconnects cross-workspace moves instead of inheriting the wrong login", async () => {
    const state = harness();
    await state.service.refresh();
    state.service.reconcile();
    state.setTabs([{ ...state.tabs()[0], spaceId: "other" }]);
    state.service.reconcile();
    expect(state.tabs()[0].external).toMatchObject({
      connected: false,
      error: expect.stringContaining("destination workspace"),
    });
    await state.service.refresh();
    expect(state.create).toHaveBeenCalledTimes(1);
  });

  it("isolates equal tab IDs in two profiles and refuses ambiguous new tabs", async () => {
    const state = harness();
    state.connections([
      connection(),
      {
        ...connection(),
        connectionId: "second",
        profile: {
          ...profile,
          profileId: "ffeeddcc-bbaa-9988-7766-554433221100",
        },
      },
    ]);
    await state.service.refresh();
    expect(state.tabs()).toHaveLength(2);
    expect(state.tabs()[0].id).not.toBe(state.tabs()[1].id);
    await expect(
      state.service.open("https://example.org", "D:/work"),
    ).rejects.toThrow("Several browser profiles");
  });

  it("opens agent tabs without focusing Chrome and uses the bound Anbo ID", async () => {
    const state = harness();
    expect(await state.service.open("https://example.com/", "D:/work")).toBe(
      100,
    );
    expect(state.calls).toHaveBeenCalledWith(
      "browser_external_open_tab",
      expect.objectContaining({ activate: false }),
    );
  });

  it("does not bind unapproved profiles or allocate idle timers", async () => {
    const timer = vi.spyOn(globalThis, "setInterval");
    try {
      const state = harness();
      state.connections([{ ...connection(), workspace: null }]);
      await state.service.refresh();
      expect(state.create).not.toHaveBeenCalled();
      expect(timer).not.toHaveBeenCalled();
    } finally {
      timer.mockRestore();
    }
  });

  it("turns a new tab page into the page it opens instead of adding a tab", async () => {
    const state = harness([
      { id: 7, kind: "browser", url: "", title: "New tab", spaceId: "work" },
    ]);
    let listed: ExternalConnection[] = [{ ...connection(), tabs: [] }];
    const reply = deferred<ExternalConnection["tabs"][number]>();
    state.calls.mockImplementation(async (command: string) => {
      if (command === "browser_external_connections") return listed;
      if (command === "browser_external_open_tab") return reply.promise;
      return undefined;
    });
    const opening = state.service.openInto(
      "https://example.com/",
      "D:/work",
      7,
      profile,
    );
    await vi.waitFor(() =>
      expect(state.calls).toHaveBeenCalledWith(
        "browser_external_open_tab",
        expect.objectContaining({ activate: false }),
      ),
    );
    // The browser announces the selection before the open's reply arrives.
    listed = [connection()];
    await state.service.refresh();
    expect(state.create).not.toHaveBeenCalled();
    reply.resolve(connection().tabs[0]);
    await expect(opening).resolves.toBe(7);
    expect(state.create).not.toHaveBeenCalled();
    expect(state.tabs()).toHaveLength(1);
    expect(state.tabs()[0]).toMatchObject({
      url: "https://example.com/",
      external: { selectionId: "lease", connected: true },
    });
    expect(state.calls).toHaveBeenCalledWith("browser_external_bind", {
      binding: expect.objectContaining({ tabId: 7, selectionId: "lease" }),
    });
  });

  it("opens into a tab only with its profile approved for the workspace", async () => {
    const state = harness([
      { id: 7, kind: "browser", url: "", title: "New tab", spaceId: "work" },
    ]);
    state.connections([{ ...connection(), workspace: null }]);
    await expect(
      state.service.openInto("https://example.com/", "D:/work", 7, profile),
    ).rejects.toThrow("not connected to this workspace");
    state.connections([{ ...connection(), workspace: "D:/other" }]);
    await expect(
      state.service.openInto("https://example.com/", "D:/work", 7, profile),
    ).rejects.toThrow("not connected to this workspace");
    expect(state.calls).not.toHaveBeenCalledWith(
      "browser_external_open_tab",
      expect.anything(),
    );
  });

  it("opens into a tab with the profile it was started from among several", async () => {
    const state = harness([
      { id: 7, kind: "browser", url: "", title: "New tab", spaceId: "work" },
    ]);
    const personal = {
      ...profile,
      profileId: "ffeeddcc-bbaa-9988-7766-554433221100",
      name: "Personal",
    };
    const listed: ExternalConnection[] = [
      { ...connection(), tabs: [] },
      {
        ...connection(),
        connectionId: "personal",
        profile: personal,
        tabs: [],
      },
    ];
    state.calls.mockImplementation(async (command: string) => {
      if (command === "browser_external_connections") return listed;
      // Refused, so the test stops at which profile was asked.
      if (command === "browser_external_open_tab")
        throw new Error("browser closed");
      return undefined;
    });
    await expect(
      state.service.openInto("https://example.com/", "D:/work", 7, personal),
    ).rejects.toThrow("browser closed");
    expect(state.calls).toHaveBeenCalledWith("browser_external_open_tab", {
      connectionId: "personal",
      url: "https://example.com/",
      activate: false,
    });
  });

  it("brings a profile's existing tab into Anbo and names the Anbo tab", async () => {
    const state = harness();
    let listed: ExternalConnection[] = [{ ...connection(), tabs: [] }];
    state.calls.mockImplementation(async (command: string) => {
      if (command === "browser_external_connections") return listed;
      if (command === "browser_external_select_tab") {
        listed = [connection()];
        return connection().tabs[0];
      }
      return undefined;
    });
    await expect(
      state.service.select("session", 10, "https://example.com/"),
    ).resolves.toBe(100);
    expect(state.create).toHaveBeenCalledTimes(1);
    expect(state.service.tabFor("session", "lease")).toBe(100);
  });

  it("publishes every connection list it reads", async () => {
    const publish = vi.fn();
    const service = createExternalBrowserSync(
      {
        tabs: () => [],
        spaces: () => [],
        create: vi.fn(),
        update: vi.fn(),
        warm: vi.fn(),
        publish,
      },
      (async () => [connection()]) as unknown as typeof invoke,
    );
    await service.refresh();
    expect(publish).toHaveBeenCalledWith([connection()]);
  });
});

describe("agent opens before the service runs", () => {
  const listed = vi.mocked(invoke);
  const plain: Tab = {
    id: 1,
    kind: "browser",
    spaceId: "work",
    url: "https://example.com/",
    title: "Example",
  };
  const saved: Tab = { ...plain, id: 2, external: profile };

  it("opens in Anbo's browser when no profile is approved for the workspace", async () => {
    listed.mockResolvedValueOnce([{ ...connection(), workspace: null }]);
    await expect(
      openExternalBrowser("https://example.org/", "D:/work", [plain], "work"),
    ).resolves.toBeNull();
    expect(listed).toHaveBeenLastCalledWith("browser_external_connections");
  });

  it("still opens in Anbo's browser when the connections cannot be read", async () => {
    listed.mockRejectedValueOnce(new Error("bridge unavailable"));
    await expect(
      openExternalBrowser("https://example.org/", "D:/work", [], "work"),
    ).resolves.toBeNull();
  });

  it("waits for a profile approved for the workspace instead of switching logins", async () => {
    listed.mockResolvedValueOnce([connection()]);
    await expect(
      openExternalBrowser("https://example.org/", "d:\\work", [plain], "work"),
    ).rejects.toThrow("not ready");
  });

  it("waits while the workspace shows a Chrome or Edge tab", async () => {
    listed.mockClear();
    await expect(
      openExternalBrowser("https://example.org/", "D:/work", [saved], "work"),
    ).rejects.toThrow("not ready");
    expect(listed).not.toHaveBeenCalled();
  });

  it("ignores Chrome or Edge tabs of other workspaces", async () => {
    listed.mockResolvedValueOnce([]);
    await expect(
      openExternalBrowser(
        "https://example.org/",
        "D:/work",
        [{ ...saved, spaceId: "other" }],
        "work",
      ),
    ).resolves.toBeNull();
  });
});
