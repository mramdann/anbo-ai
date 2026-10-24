import {
  type ExternalBrowser,
  type ExternalConnection,
  savedExternalBrowser,
} from "@/modules/browser/external/model";
import {
  openReadHoldsDock,
  releaseDockForOpenRead,
} from "@/modules/browser/external/openReads";
import {
  createExternalBrowserSync,
  openExternalBrowser,
} from "@/modules/browser/external/sync";
import { noteTabClosed } from "@/modules/tabs/lib/closedTabs";
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
  // The tab whose panel shows.
  let active = -1;
  const create = vi.fn(
    (
      url: string,
      _activate: boolean,
      spaceId: string,
      external: ExternalBrowser,
      after?: number,
    ) => {
      const id = nextId++;
      const tab: Tab = {
        id,
        kind: "browser",
        url,
        title: url,
        spaceId,
        external,
      };
      const at = tabs.findIndex((other) => other.id === after);
      tabs =
        at < 0
          ? [...tabs, tab]
          : [...tabs.slice(0, at + 1), tab, ...tabs.slice(at + 1)];
      return id;
    },
  );
  const activate = vi.fn((id: number) => {
    active = id;
  });
  const update = (id: number, patch: TabPatch) => {
    tabs = tabs.map((tab) =>
      tab.id === id ? ({ ...tab, ...patch } as Tab) : tab,
    );
  };
  const warm = vi.fn((id: number) => {
    tabs = tabs.map((tab) => (tab.id === id ? { ...tab, cold: false } : tab));
  });
  const close = vi.fn((id: number) => {
    tabs = tabs.filter((tab) => tab.id !== id);
  });
  const service = createExternalBrowserSync(
    {
      tabs: () => tabs,
      spaces: () => spaces,
      create,
      update,
      warm,
      shown: (id) => id === active,
      activate,
      close,
    },
    calls as typeof invoke,
  );
  return {
    service,
    calls,
    create,
    warm,
    activate,
    close,
    setShown: (id: number) => {
      active = id;
    },
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
        close: false,
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
      close: false,
    });
  });

  it("marks a new tab connecting while its binding runs", async () => {
    // Round 64 (R64-3): a tab a page had opened read pageGone until its
    // binding landed.
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
    expect(state.tabs()[0].external).toMatchObject({
      connected: false,
      connecting: true,
    });
    pending.resolve();
    await refresh;
    expect(state.tabs()[0].external?.connected).toBe(true);
    expect(state.tabs()[0].external?.connecting).toBeUndefined();
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
      close: false,
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
      undefined,
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
      close: false,
    });
  });

  it("closes the browser's tab with an Anbo tab closed on purpose", async () => {
    const state = harness();
    await state.service.refresh();
    state.service.reconcile();
    noteTabClosed(100);
    state.setTabs([]);
    state.service.reconcile();
    expect(state.calls).toHaveBeenCalledWith("browser_external_unbind", {
      tabId: 100,
      connectionId: "session",
      selectionId: "lease",
      forget: true,
      close: true,
    });
  });

  it("closes the Anbo tab whose page was closed in its browser, and no other tab", async () => {
    const terminal: Tab = {
      id: 7,
      kind: "terminal",
      spaceId: "work",
      title: "shell",
      paneTree: { kind: "leaf", id: 8 },
      activeLeafId: 8,
    };
    const state = harness([terminal]);
    await state.service.refresh();
    state.service.reconcile();
    expect(state.tabs().map((tab) => tab.id)).toEqual([7, 100]);
    state.service.closedInBrowser(7);
    state.service.closedInBrowser(55);
    expect(state.close).not.toHaveBeenCalled();
    state.service.closedInBrowser(100);
    expect(state.close).toHaveBeenCalledExactlyOnceWith(100);
    expect(state.tabs().map((tab) => tab.id)).toEqual([7]);
    // A stopped service closes nothing.
    state.service.stop();
    state.service.closedInBrowser(7);
    expect(state.close).toHaveBeenCalledTimes(1);
  });

  it("leaves the browser's tab open when its workspace takes the Anbo tab along", async () => {
    const state = harness();
    await state.service.refresh();
    state.service.reconcile();
    // A deleted workspace drops its space, then its tabs, closing none of
    // them on purpose.
    state.setSpaces([{ id: "other", root: "D:/other" }]);
    state.setTabs([]);
    state.service.reconcile();
    expect(state.calls).toHaveBeenCalledWith(
      "browser_external_unbind",
      expect.objectContaining({ tabId: 100, close: false }),
    );
  });

  const openedTab = (
    id: number,
    selectionId: string,
    how: { background?: boolean; agent?: boolean } = {},
  ): ExternalConnection["tabs"][number] => ({
    id,
    title: "Next",
    url: `https://example.com/${selectionId}`,
    selectionId,
    loading: false,
    openedFrom: {
      selectionId: "lease",
      background: false,
      agent: false,
      ...how,
    },
  });

  it("opens a tab a shown page opened beside it, in front for the user's own click", async () => {
    const state = harness();
    await state.service.refresh();
    state.service.reconcile();
    state.setShown(100);
    const tabs = [...connection().tabs, openedTab(12, "child")];
    state.connections([{ ...connection(), tabs }]);
    await state.service.refresh();
    expect(state.create).toHaveBeenLastCalledWith(
      "https://example.com/child",
      false,
      "work",
      expect.any(Object),
      100,
    );
    expect(state.activate).toHaveBeenCalledExactlyOnceWith(101);
    // A Ctrl or middle click: after the one before it, and behind.
    state.setShown(100);
    tabs.push(openedTab(13, "second", { background: true }));
    state.connections([{ ...connection(), tabs }]);
    await state.service.refresh();
    expect(state.tabs().map((tab) => tab.id)).toEqual([100, 101, 102]);
    expect(state.activate).toHaveBeenCalledTimes(1);
  });

  it("keeps behind a tab an agent's input opened, or one from a page not shown", async () => {
    const state = harness();
    await state.service.refresh();
    state.service.reconcile();
    state.setShown(100);
    const tabs = [
      ...connection().tabs,
      openedTab(12, "agent", { agent: true }),
    ];
    state.connections([{ ...connection(), tabs }]);
    await state.service.refresh();
    state.setShown(-1);
    tabs.push(openedTab(13, "behind"));
    state.connections([{ ...connection(), tabs }]);
    await state.service.refresh();
    expect(state.create).toHaveBeenCalledTimes(3);
    expect(state.activate).not.toHaveBeenCalled();
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

  describe("an agent's open among several approved profiles", () => {
    const personal = {
      profileId: "ffeeddcc-bbaa-9988-7766-554433221100",
      browser: "edge" as const,
      name: "Personal",
    };
    const twoProfiles = (second = personal) => {
      const state = harness();
      const listed: ExternalConnection[] = [
        connection(),
        {
          connectionId: "personal",
          profile: second,
          workspace: "D:/work",
          tabs: [
            {
              id: 20,
              title: "Inbox",
              url: "https://mail.example.com/",
              selectionId: "lease-2",
              loading: false,
            },
          ],
        },
      ];
      state.connections(listed);
      state.calls.mockImplementation(
        async (command: string, args?: unknown) => {
          if (command === "browser_external_connections") return listed;
          if (command === "browser_external_open_tab")
            return listed.find(
              (item) =>
                item.connectionId ===
                (args as { connectionId: string }).connectionId,
            )?.tabs[0];
          return undefined;
        },
      );
      return state;
    };

    it("names every approved profile when the agent named none", async () => {
      const state = twoProfiles();
      await expect(
        state.service.open("https://example.org", "D:/work"),
      ).rejects.toThrow(
        'Several browser profiles are approved here: "Work" (Chrome), "Personal" (Edge). Pass one as profile,',
      );
      expect(state.calls).not.toHaveBeenCalledWith(
        "browser_external_open_tab",
        expect.anything(),
      );
    });

    it("opens in the profile the agent named, by name in any case or by id", async () => {
      for (const named of ["Personal", " personal ", personal.profileId]) {
        const state = twoProfiles();
        await expect(
          state.service.open("https://example.org", "D:/work", false, named),
        ).resolves.toBe(101);
        expect(state.calls).toHaveBeenCalledWith("browser_external_open_tab", {
          connectionId: "personal",
          url: "https://example.org",
          activate: false,
        });
      }
    });

    it("refuses a profile that is not approved here and lists those that are", async () => {
      const state = twoProfiles();
      await expect(
        state.service.open("https://example.org", "D:/work", false, "Home"),
      ).rejects.toThrow(
        'No browser profile named "Home" is approved here. Approved here: "Work" (Chrome), "Personal" (Edge).',
      );
    });

    it("asks for the id when two approved profiles share the name", async () => {
      const state = twoProfiles({ ...personal, name: "Work" });
      await expect(
        state.service.open("https://example.org", "D:/work", false, "work"),
      ).rejects.toThrow(
        `Several approved profiles are named "work": "Work" (Chrome, id ${profile.profileId}), "Work" (Edge, id ${personal.profileId}). Pass the profile's id instead.`,
      );
      await expect(
        state.service.open(
          "https://example.org",
          "D:/work",
          false,
          personal.profileId,
        ),
      ).resolves.toBe(101);
    });

    it("opens in two profiles at once, and one after another in the same profile", async () => {
      const state = twoProfiles();
      const work = deferred<void>();
      const listed = await state.calls("browser_external_connections");
      const opened: string[] = [];
      state.calls.mockImplementation(
        async (command: string, args?: unknown) => {
          if (command === "browser_external_connections") return listed;
          if (command === "browser_external_open_tab") {
            const { connectionId } = args as { connectionId: string };
            opened.push(connectionId);
            if (connectionId === "session" && opened.length === 1)
              await work.promise;
            return (listed as ExternalConnection[]).find(
              (item) => item.connectionId === connectionId,
            )?.tabs[0];
          }
          return undefined;
        },
      );
      const first = state.service.open(
        "https://example.org",
        "D:/work",
        false,
        "Work",
      );
      const sameProfile = state.service.open(
        "https://example.net",
        "D:/work",
        false,
        "Work",
      );
      const other = state.service.open(
        "https://example.com",
        "D:/work",
        false,
        "Personal",
      );
      await expect(other).resolves.toBeTypeOf("number");
      expect(opened).toEqual(["session", "personal"]);
      work.resolve();
      await Promise.all([first, sameProfile]);
      expect(opened).toEqual(["session", "personal", "session"]);
    });

    it("does not start an open still waiting for its profile at its deadline", async () => {
      const state = twoProfiles();
      const work = deferred<void>();
      const listed = await state.calls("browser_external_connections");
      state.calls.mockImplementation(
        async (command: string, args?: unknown) => {
          if (command === "browser_external_connections") return listed;
          if (command === "browser_external_open_tab") {
            await work.promise;
            return (listed as ExternalConnection[]).find(
              (item) =>
                item.connectionId ===
                (args as { connectionId: string }).connectionId,
            )?.tabs[0];
          }
          return undefined;
        },
      );
      const first = state.service.open(
        "https://example.org",
        "D:/work",
        false,
        "Work",
      );
      const late = state.service.open(
        "https://example.net",
        "D:/work",
        false,
        "Work",
        Date.now() + 20,
      );
      await new Promise((resolve) => setTimeout(resolve, 40));
      work.resolve();
      await first;
      await expect(late).rejects.toThrow(
        "Anbo was still opening other tabs in this browser profile, so this page was not opened.",
      );
      expect(
        state.calls.mock.calls.filter(
          ([command]) => command === "browser_external_open_tab",
        ),
      ).toHaveLength(1);
    });

    it("does not open in a profile given to another workspace while the open waited", async () => {
      const state = twoProfiles();
      const work = deferred<void>();
      let listed = (await state.calls(
        "browser_external_connections",
      )) as ExternalConnection[];
      state.calls.mockImplementation(
        async (command: string, args?: unknown) => {
          if (command === "browser_external_connections") return listed;
          if (command === "browser_external_open_tab") {
            await work.promise;
            return listed.find(
              (item) =>
                item.connectionId ===
                (args as { connectionId: string }).connectionId,
            )?.tabs[0];
          }
          return undefined;
        },
      );
      const first = state.service.open(
        "https://example.org",
        "D:/work",
        false,
        "Personal",
      );
      const waiting = state.service.open(
        "https://example.net",
        "D:/work",
        false,
        "Personal",
      );
      await vi.waitFor(() =>
        expect(state.calls).toHaveBeenCalledWith(
          "browser_external_open_tab",
          expect.objectContaining({ connectionId: "personal" }),
        ),
      );
      listed = listed.map((item) =>
        item.connectionId === "personal"
          ? { ...item, workspace: "D:/other" }
          : item,
      );
      work.resolve();
      await first.catch(() => {});
      await expect(waiting).rejects.toThrow(
        "This browser profile is no longer approved for this workspace",
      );
      expect(
        state.calls.mock.calls.filter(
          ([command]) => command === "browser_external_open_tab",
        ),
      ).toHaveLength(1);
    });

    it("never takes a named profile approved for another workspace, nor Anbo's browser", async () => {
      const state = harness();
      state.connections([{ ...connection(), workspace: "D:/other" }]);
      // Null would open the page in Anbo's browser, with another login.
      await expect(
        state.service.open("https://example.org", "D:/work", false, "Work"),
      ).rejects.toThrow(
        'No Chrome/Edge profile is approved for this workspace, so "Work" cannot be used.',
      );
    });
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

  it("holds the dock for the tab an agent's open reads, and only for it", async () => {
    const open = (holdDock: boolean) => {
      const state = harness();
      // The browser lists the new tab once it has opened it.
      let listed: ExternalConnection[] = [{ ...connection(), tabs: [] }];
      state.calls.mockImplementation(async (command: string) => {
        if (command === "browser_external_connections") return listed;
        if (command === "browser_external_open_tab") {
          listed = [connection()];
          return connection().tabs[0];
        }
        return undefined;
      });
      return state.service.open("https://example.com/", "D:/work", holdDock);
    };
    expect(await open(true)).toBe(100);
    expect(openReadHoldsDock(100)).toBe(true);
    releaseDockForOpenRead(100);
    expect(await open(false)).toBe(100);
    expect(openReadHoldsDock(100)).toBe(false);
  });

  it("holds the dock for a read tab the browser announced before the open's reply", async () => {
    const state = harness();
    let listed: ExternalConnection[] = [{ ...connection(), tabs: [] }];
    const reply = deferred<ExternalConnection["tabs"][number]>();
    state.calls.mockImplementation(async (command: string) => {
      if (command === "browser_external_connections") return listed;
      if (command === "browser_external_open_tab") return reply.promise;
      return undefined;
    });
    const opening = state.service.open("https://example.com/", "D:/work", true);
    await vi.waitFor(() =>
      expect(state.calls).toHaveBeenCalledWith(
        "browser_external_open_tab",
        expect.objectContaining({ activate: false }),
      ),
    );
    listed = [connection()];
    await state.service.refresh();
    expect(openReadHoldsDock(100)).toBe(true);
    reply.resolve(connection().tabs[0]);
    await expect(opening).resolves.toBe(100);
    expect(state.create).toHaveBeenCalledTimes(1);
    releaseDockForOpenRead(100);
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

  it("waits when the agent named a profile, which only the service can find", async () => {
    listed.mockClear();
    await expect(
      openExternalBrowser(
        "https://example.org/",
        "D:/work",
        [plain],
        "work",
        false,
        "Work",
      ),
    ).rejects.toThrow("not ready");
    expect(listed).not.toHaveBeenCalled();
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
