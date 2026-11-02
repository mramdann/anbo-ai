import { externalPaneShown } from "@/modules/browser/external/docking";
import {
  type ExternalBrowser,
  type ExternalConnection,
  sameWorkspace,
  selectionKey,
  servesWorkspace,
} from "@/modules/browser/external/model";
import {
  holdDockForOpenRead,
  releaseDockForOpenRead,
} from "@/modules/browser/external/openReads";
import {
  POINTER_TURN_EVENT,
  setPointerTurn,
} from "@/modules/browser/external/pointerTurn";
import { useExternalBrowsers } from "@/modules/browser/external/store";
import { beginBrowserSession } from "@/modules/browser/native";
import { takeTabClosed } from "@/modules/tabs/lib/closedTabs";
import type { BrowserTab, Tab, TabPatch } from "@/modules/tabs/lib/useTabs";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { warn } from "@tauri-apps/plugin-log";

type Space = { id: string; root: string | null };
type RootedSpace = Space & { root: string };
type RemoteTab = ExternalConnection["tabs"][number];
type Host = {
  tabs: () => Tab[];
  spaces: () => Space[];
  create: (
    url: string,
    activate: boolean,
    spaceId: string,
    external: ExternalBrowser,
    /** The tab to place it after. */
    after?: number,
  ) => number;
  update: (id: number, patch: TabPatch) => void;
  warm: (id: number) => void;
  /** Whether a tab's panel shows now, and bringing a tab to the front. */
  shown?: (id: number) => boolean;
  activate?: (id: number) => void;
  /** Closes a tab, as the user's close does. */
  close?: (id: number) => void;
  /** Receives every connection list the service reads. */
  publish?: (connections: ExternalConnection[]) => void;
};
type Binding = {
  id: number;
  spaceId: string;
  connectionId: string;
  selectionId: string;
  seen: boolean;
  ready: boolean;
  error?: string;
};

/** Whether an Anbo space shows a tab from a Chrome or Edge profile. */
function showsExternalTabs(tabs: Tab[], spaceId: string | undefined) {
  return tabs.some(
    (tab) =>
      tab.kind === "browser" &&
      Boolean(tab.external) &&
      tab.spaceId === spaceId,
  );
}

/** Whether an agent's open names this profile, by its name in any case or by
 *  its id. */
function namesProfile(
  profile: ExternalConnection["profile"],
  requested: string,
): boolean {
  const wanted = requested.trim().toLowerCase();
  return (
    profile.name.trim().toLowerCase() === wanted ||
    profile.profileId.toLowerCase() === wanted
  );
}

/** Approved profiles the way an error names them, so the agent can pass one
 *  back as the open's profile. A name two of them share comes with ids. */
function listProfiles(connections: ExternalConnection[]): string {
  return connections
    .map(({ profile }) => {
      const browser = profile.browser === "edge" ? "Edge" : "Chrome";
      const shared =
        connections.filter((other) => namesProfile(other.profile, profile.name))
          .length > 1;
      return `"${profile.name}" (${browser}${shared ? `, id ${profile.profileId}` : ""})`;
    })
    .join(", ");
}

export function createExternalBrowserSync(
  host: Host,
  call: typeof invoke = invoke,
) {
  let connections: ExternalConnection[] = [];
  let dirty = false;
  let stopped = false;
  let flight: Promise<void> | undefined;
  const bindings = new Map<string, Binding>();
  const released = new Set<string>();
  // A selection that becomes an existing Anbo tab (a new tab page opening its
  // first page in the browser) instead of a tab created for it.
  const claims = new Map<string, number>();
  // Until the claim exists, that profile's new selections wait, so the event
  // that announces the selection cannot create a second tab for it.
  const opening = new Set<string>();
  // Agent opens whose read holds the dock, by profile connection. The browser's
  // change event can make the new tab before the open learns its selection, so
  // the next tab made for that profile is taken as the page the open reads.
  const reading = new Set<string>();
  // A profile can serve several workspaces, and a new selection alone does not
  // say which one it is for. While an open or a selection of such a profile
  // waits for its answer, that profile's new selections Anbo cannot place
  // wait too; the answer names the workspace its selection goes to.
  const placing = new Set<string>();
  const assigned = new Map<string, string>();
  // The newest tab each Anbo tab's page opened, so the next one goes after it
  // the way a browser lines them up.
  const opened = new Map<number, number>();
  // Opens and selections of one profile run one at a time, so a waiting
  // selection is always the one being opened. Other profiles go on meanwhile.
  const queues = new Map<string, Promise<unknown>>();
  const exclusive = <T>(
    connectionId: string,
    run: () => Promise<T>,
  ): Promise<T> => {
    const next = (queues.get(connectionId) ?? Promise.resolve())
      .catch(() => {})
      .then(run);
    queues.set(connectionId, next);
    const forget = () => {
      if (queues.get(connectionId) === next) queues.delete(connectionId);
    };
    next.then(forget, forget);
    return next;
  };
  const approvedFor = (connectionId: string, workspace: string) =>
    connections.find(
      (connection) =>
        connection.connectionId === connectionId &&
        servesWorkspace(connection, workspace),
    );
  /** The spaces a profile's tabs can show in: its workspaces'. */
  const spacesOf = (connection: ExternalConnection) =>
    host
      .spaces()
      .filter(
        (space): space is RootedSpace =>
          space.root !== null && servesWorkspace(connection, space.root),
      );
  /** The profile's own name for the workspace a space shows, as its binding
   *  names it. */
  const workspaceOf = (connection: ExternalConnection, space: RootedSpace) =>
    connection.workspaces.find((workspace) =>
      sameWorkspace(workspace, space.root),
    ) ?? space.root;
  const externalTabs = (tabs: Tab[]) =>
    new Map(
      tabs.flatMap((tab) =>
        tab.kind === "browser" && tab.external
          ? [[tab.id, tab.external] as const]
          : [],
      ),
    );
  let knownTabs = externalTabs(host.tabs());

  /** Lets go of a bound tab's page. */
  const letGo = (key: string, binding: Binding, tab: Tab | undefined) => {
    released.add(key);
    bindings.delete(key);
    if (tab?.kind === "browser" && tab.external)
      host.update(tab.id, {
        external: {
          ...tab.external,
          connected: false,
          error: "Reconnect this profile for the destination workspace.",
        },
        loading: false,
      });
    void call("browser_external_unbind", {
      tabId: binding.id,
      connectionId: binding.connectionId,
      selectionId: binding.selectionId,
      forget: !tab,
      // Closed on purpose, the browser's tab closes too; moved to another
      // workspace, or gone with its workspace, it stays open there.
      close: !tab && takeTabClosed(binding.id),
    }).catch(() => {});
  };

  /** A tab moved to another workspace its profile serves keeps its page: the
   *  binding goes along. Refused there, it lets go as any other move does. */
  const follow = (
    key: string,
    binding: Binding,
    connection: ExternalConnection,
    remote: RemoteTab,
    space: RootedSpace,
  ) => {
    binding.spaceId = space.id;
    binding.seen = true;
    void call("browser_external_bind", {
      binding: {
        connectionId: binding.connectionId,
        browserTabId: remote.id,
        selectionId: binding.selectionId,
        tabId: binding.id,
        workspace: workspaceOf(connection, space),
      },
    }).catch(() => {
      if (stopped || bindings.get(key) !== binding) return;
      letGo(
        key,
        binding,
        host.tabs().find((tab) => tab.id === binding.id),
      );
    });
  };

  const reconcile = (tabs = host.tabs()) => {
    if (stopped) return;
    const nextTabs = externalTabs(tabs);
    const forgotten = new Set<number>();
    for (const [key, binding] of bindings) {
      const tab = tabs.find((tab) => tab.id === binding.id);
      if (tab?.spaceId === binding.spaceId) {
        binding.seen = true;
        continue;
      }
      if (!binding.seen && !tab) continue;
      const connection = connections.find(
        (connection) => connection.connectionId === binding.connectionId,
      );
      const remote = connection?.tabs.find(
        (remote) => remote.selectionId === binding.selectionId,
      );
      const destination =
        connection &&
        spacesOf(connection).find((space) => space.id === tab?.spaceId);
      // One still binding lets go: its first bind could land after this one.
      if (
        tab?.kind === "browser" &&
        binding.ready &&
        connection &&
        remote &&
        destination
      ) {
        follow(key, binding, connection, remote, destination);
        continue;
      }
      letGo(key, binding, tab);
      if (!tab) forgotten.add(binding.id);
    }
    for (const [id, external] of knownTabs) {
      if (!nextTabs.has(id) && !forgotten.has(id))
        void call("browser_external_unbind", {
          tabId: id,
          connectionId: external.connectionId,
          selectionId: external.selectionId,
          forget: true,
          close: takeTabClosed(id),
        }).catch(() => {});
    }
    for (const openerId of opened.keys())
      if (!nextTabs.has(openerId)) opened.delete(openerId);
    knownTabs = nextTabs;
  };

  /** Where a selection Anbo has not bound yet goes: undefined while that is
   *  not known yet, null when none of its profile's workspaces takes it. */
  const placeOf = (
    connection: ExternalConnection,
    remote: RemoteTab,
    key: string,
    spaces: RootedSpace[],
  ): RootedSpace | null | undefined => {
    const inSpace = (spaceId: string | undefined) =>
      spaces.find((space) => space.id === spaceId);
    const claimed = host.tabs().find((tab) => tab.id === claims.get(key));
    const claimedSpace = inSpace(claimed?.spaceId);
    if (claimedSpace) return claimedSpace;
    // Until the claim exists, so the event that announces the selection
    // cannot create a second tab for it.
    if (opening.has(connection.connectionId)) return undefined;
    // The workspace an open or selection asked for, or the one its tab was
    // last bound in (before this page reloaded, or before the profile left
    // that workspace).
    const root = assigned.get(key) ?? connection.placed?.[remote.selectionId];
    if (root !== undefined)
      return spaces.find((space) => sameWorkspace(space.root, root)) ?? null;
    if (connection.workspaces.length === 1) return spaces[0];
    // A page shown in Anbo opened it: it goes where that page is.
    const opener =
      remote.openedFrom &&
      bindings.get(
        selectionKey(connection.connectionId, remote.openedFrom.selectionId),
      );
    if (opener) return inSpace(opener.spaceId) ?? null;
    return placing.has(connection.connectionId) ? undefined : null;
  };

  const apply = async () => {
    const present = new Set(
      connections.flatMap((connection) =>
        connection.tabs
          .filter((tab) => tab.selectionId)
          .map((tab) => selectionKey(connection.connectionId, tab.selectionId)),
      ),
    );
    // A binding stays while its selection does and its profile still serves
    // the workspace its tab is in.
    const kept = new Set<string>();
    for (const connection of connections) {
      const spaces = spacesOf(connection);
      for (const remote of connection.tabs) {
        if (!remote.selectionId) continue;
        const key = selectionKey(connection.connectionId, remote.selectionId);
        const spaceId = bindings.get(key)?.spaceId;
        if (spaces.some((space) => space.id === spaceId)) kept.add(key);
      }
    }
    for (const [key, binding] of bindings) {
      if (kept.has(key)) continue;
      bindings.delete(key);
      // Its profile left the tab's workspace: while the browser still lists
      // the page, it is not made again in another one.
      if (present.has(key)) released.add(key);
      const tab = host.tabs().find((tab) => tab.id === binding.id);
      if (tab?.kind === "browser" && tab.external)
        host.update(tab.id, {
          loading: false,
          external: { ...tab.external, connected: false },
        });
    }
    for (const connection of connections) {
      const spaces = spacesOf(connection);
      if (!spaces.length) continue;
      for (const remote of connection.tabs) {
        if (!remote.selectionId) continue;
        const key = selectionKey(connection.connectionId, remote.selectionId);
        if (released.has(key)) continue;
        let binding = bindings.get(key);
        const boundSpace = binding?.spaceId;
        const space = binding
          ? spaces.find((space) => space.id === boundSpace)
          : placeOf(connection, remote, key, spaces);
        if (space === undefined) continue;
        if (space === null) {
          // None of its profile's workspaces takes it: the browser keeps it.
          released.add(key);
          void call("browser_external_release_tab", {
            connectionId: connection.connectionId,
            tabId: remote.id,
          }).catch(() => {});
          continue;
        }
        const external: ExternalBrowser = {
          ...connection.profile,
          connectionId: connection.connectionId,
          browserTabId: remote.id,
          selectionId: remote.selectionId,
          connected: binding?.ready ?? false,
          error: binding?.error,
        };
        if (!binding) {
          const claimedTab = host
            .tabs()
            .find(
              (tab) => tab.id === claims.get(key) && tab.spaceId === space.id,
            );
          const claimed = new Set(
            [...bindings.values()].map((binding) => binding.id),
          );
          const candidates = host
            .tabs()
            .filter(
              (tab): tab is BrowserTab =>
                tab.kind === "browser" &&
                tab.spaceId === space.id &&
                !claimed.has(tab.id) &&
                tab.external?.profileId === connection.profile.profileId &&
                tab.external.browser === connection.profile.browser &&
                ((tab.external.connectionId === connection.connectionId &&
                  tab.external.selectionId === remote.selectionId) ||
                  tab.url === remote.url),
            );
          const saved =
            candidates.find(
              (tab) =>
                tab.external?.connectionId === connection.connectionId &&
                tab.external.selectionId === remote.selectionId,
            ) ?? (candidates.length === 1 ? candidates[0] : undefined);
          // A page shown in Anbo opened this tab: it goes beside that page's
          // tab, after the ones that page opened before.
          const opener = remote.openedFrom
            ? bindings.get(
                selectionKey(
                  connection.connectionId,
                  remote.openedFrom.selectionId,
                ),
              )
            : undefined;
          const beside = opener?.spaceId === space.id ? opener : undefined;
          const last = beside && opened.get(beside.id);
          const after =
            last !== undefined && host.tabs().some((tab) => tab.id === last)
              ? last
              : beside?.id;
          // Connecting until the binding lands, so the tab does not read as
          // one whose page is gone meanwhile.
          const connecting = { ...external, connecting: true };
          const existing = claimedTab?.id ?? saved?.id;
          if (existing !== undefined)
            host.update(existing, { external: connecting });
          const id =
            existing ??
            host.create(remote.url, false, space.id, connecting, after);
          if (beside) opened.set(beside.id, id);
          // The agent's open reads this page before it answers, and a dock
          // move would stall that read, so the dock waits for it. A tab a
          // page opened is never that page.
          if (!remote.openedFrom && reading.delete(connection.connectionId))
            holdDockForOpenRead(id);
          binding = {
            id,
            spaceId: space.id,
            connectionId: connection.connectionId,
            selectionId: remote.selectionId,
            seen: Boolean(claimedTab ?? saved),
            ready: false,
          };
          bindings.set(key, binding);
          try {
            await call("browser_external_bind", {
              binding: {
                connectionId: connection.connectionId,
                browserTabId: remote.id,
                selectionId: remote.selectionId,
                tabId: id,
                workspace: workspaceOf(connection, space),
              },
            });
            if (stopped) return;
            reconcile();
            if (bindings.get(key) !== binding) continue;
            binding.ready = true;
            external.connected = true;
            host.warm(id);
            // A tab an agent's input opened is the agent's (browser_tabs
            // yours), as one it opened itself is.
            if (opener && remote.openedFrom?.agent) {
              void call("browser_note_opened_from", {
                sourceTabId: opener.id,
                tabId: id,
              }).catch(() => {});
            }
            // In front, as the browser opened it, when the user's own click
            // on the page they see opened it. One an agent's input or a Ctrl
            // or middle click opened stays behind.
            if (
              beside &&
              remote.openedFrom &&
              !remote.openedFrom.background &&
              !remote.openedFrom.agent &&
              host.shown?.(beside.id)
            )
              host.activate?.(id);
          } catch (cause) {
            if (stopped) return;
            reconcile();
            if (bindings.get(key) !== binding) continue;
            external.error = String(cause);
            binding.error = external.error;
          }
        }
        if (stopped) return;
        if (bindings.get(key) !== binding) continue;
        const previous = host.tabs().find((tab) => tab.id === binding.id);
        const unchanged =
          previous?.kind === "browser" &&
          previous.external?.connectionId === external.connectionId &&
          previous.external?.selectionId === external.selectionId &&
          previous.external?.connected === external.connected &&
          previous.external?.connecting === external.connecting &&
          previous.external?.error === external.error;
        host.update(binding.id, {
          url: remote.url,
          title: remote.title || remote.url,
          loading: remote.loading,
          ...(!unchanged && { external }),
        });
      }
    }
    for (const key of released) if (!present.has(key)) released.delete(key);
  };

  const refresh = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    dirty = true;
    flight ??= (async () => {
      while (dirty && !stopped) {
        dirty = false;
        connections = await call<ExternalConnection[]>(
          "browser_external_connections",
        );
        if (stopped) break;
        host.publish?.(connections);
        await apply();
      }
    })().finally(() => {
      flight = undefined;
      if (dirty && !stopped) return refresh();
    });
    return flight;
  };

  const ensureRunning = () => {
    if (stopped)
      throw new Error(
        "Browser synchronization stopped; retry from the current workspace. Actions were not replayed.",
      );
  };

  /** The profile an agent's open goes to, or null for Anbo's own browser. */
  const openTarget = (
    workspace: string,
    profile: string | undefined,
  ): ExternalConnection | null => {
    const approved = connections.filter((connection) =>
      servesWorkspace(connection, workspace),
    );
    const profiles =
      profile === undefined
        ? approved
        : approved.filter((connection) =>
            namesProfile(connection.profile, profile),
          );
    if (profiles.length > 1)
      throw new Error(
        profile === undefined
          ? `Several browser profiles are approved here: ${listProfiles(approved)}. Pass one as profile, use a selected tab ID, or remove the unused profile from this workspace before opening a tab.`
          : `Several approved profiles are named "${profile}": ${listProfiles(profiles)}. Pass the profile's id instead.`,
      );
    if (!profiles.length && profile !== undefined)
      throw new Error(
        approved.length
          ? `No browser profile named "${profile}" is approved here. Approved here: ${listProfiles(approved)}.`
          : `No Chrome/Edge profile is approved for this workspace, so "${profile}" cannot be used. Connect it from the browser menu, or leave profile out to open the page in Anbo's browser.`,
      );
    if (!profiles.length) {
      const space = host
        .spaces()
        .find(
          (space) =>
            space.root !== null && sameWorkspace(space.root, workspace),
        );
      if (showsExternalTabs(host.tabs(), space?.id))
        throw new Error(
          "Reconnect this workspace's Chrome/Edge profile before opening a browser tab. Anbo will not fall back to a different login.",
        );
      return null;
    }
    return profiles[0];
  };

  /** `deadline` is when the agent stops waiting for the open. */
  const open = async (
    url: string,
    workspace: string,
    holdDock = false,
    profile?: string,
    deadline?: number,
  ): Promise<number | null> => {
    ensureRunning();
    await refresh();
    ensureRunning();
    const connection = openTarget(workspace, profile);
    if (!connection) return null;
    const { connectionId } = connection;
    return exclusive(connectionId, async () => {
      ensureRunning();
      if (deadline !== undefined && Date.now() >= deadline)
        throw new Error(
          "Anbo was still opening other tabs in this browser profile, so this page was not opened. Try again.",
        );
      // Another open of this profile may have run meanwhile, and the profile
      // may have gone to another workspace since.
      await refresh();
      ensureRunning();
      if (!approvedFor(connectionId, workspace))
        throw new Error(
          "This browser profile is no longer approved for this workspace, so the page was not opened.",
        );
      if (holdDock) reading.add(connectionId);
      placing.add(connectionId);
      let key: string | undefined;
      try {
        const remote = await call<{ selectionId: string }>(
          "browser_external_open_tab",
          { connectionId, url, activate: false },
        );
        key = selectionKey(connectionId, remote.selectionId);
        assigned.set(key, workspace);
        placing.delete(connectionId);
        ensureRunning();
        await refresh();
        ensureRunning();
        const binding = bindings.get(key);
        if (!binding?.ready)
          throw new Error(
            "The browser tab opened but could not bind to Anbo. Check browser connections; the action was not replayed.",
          );
        return binding.id;
      } finally {
        reading.delete(connectionId);
        placing.delete(connectionId);
        if (key !== undefined) assigned.delete(key);
      }
    });
  };

  /** Opens a page in a profile approved for the workspace and turns this Anbo
   * tab (a new tab page started from that profile) into that page, rather
   * than adding another tab. */
  const openInto = async (
    url: string,
    workspace: string,
    tabId: number,
    profile: ExternalConnection["profile"],
  ) => {
    const connected = () =>
      connections.find(
        (connection) =>
          servesWorkspace(connection, workspace) &&
          connection.profile.browser === profile.browser &&
          connection.profile.profileId === profile.profileId,
      );
    const notConnected =
      "This profile is not connected to this workspace. Reconnect it from the browser menu, or use Anbo's browser.";
    ensureRunning();
    await refresh();
    ensureRunning();
    const first = connected();
    if (!first) throw new Error(notConnected);
    return exclusive(first.connectionId, async () => {
      ensureRunning();
      await refresh();
      ensureRunning();
      const connection = connected();
      if (connection?.connectionId !== first.connectionId)
        throw new Error(notConnected);
      const { connectionId } = connection;
      let key: string;
      opening.add(connectionId);
      try {
        const remote = await call<{ selectionId: string }>(
          "browser_external_open_tab",
          { connectionId, url, activate: false },
        );
        key = selectionKey(connectionId, remote.selectionId);
        claims.set(key, tabId);
      } finally {
        opening.delete(connectionId);
      }
      try {
        ensureRunning();
        await refresh();
        ensureRunning();
        const binding = bindings.get(key);
        if (!binding?.ready || binding.id !== tabId)
          throw new Error(
            "The page opened in the browser but could not show in this tab. It is in the browser menu; the action was not replayed.",
          );
        return binding.id;
      } finally {
        claims.delete(key);
      }
    });
  };

  /** Brings a tab the profile already has into Anbo, in this workspace. */
  const select = (
    connectionId: string,
    browserTabId: number,
    url: string,
    workspace: string,
  ) =>
    exclusive(connectionId, async () => {
      ensureRunning();
      await refresh();
      ensureRunning();
      if (!approvedFor(connectionId, workspace))
        throw new Error(
          "This browser profile is not used in this workspace. Use it here from the browser menu first.",
        );
      placing.add(connectionId);
      let key: string | undefined;
      try {
        const remote = await call<{ selectionId: string }>(
          "browser_external_select_tab",
          { connectionId, tabId: browserTabId, expectedUrl: url },
        );
        key = selectionKey(connectionId, remote.selectionId);
        assigned.set(key, workspace);
        placing.delete(connectionId);
        ensureRunning();
        await refresh();
        ensureRunning();
        const binding = bindings.get(key);
        if (!binding?.ready)
          throw new Error(
            "The tab connected but could not open in Anbo. Try again from the browser menu.",
          );
        return binding.id;
      } finally {
        placing.delete(connectionId);
        if (key !== undefined) assigned.delete(key);
      }
    });

  return {
    refresh,
    reconcile,
    open,
    openInto,
    select,
    tabFor: (connectionId: string, selectionId: string) =>
      bindings.get(selectionKey(connectionId, selectionId))?.id,
    // Its page was closed in the browser on its own (not with its window, nor
    // by Anbo): Anbo's tab for it goes too.
    closedInBrowser: (id: number) => {
      const tab = host.tabs().find((tab) => tab.id === id);
      if (!stopped && tab?.kind === "browser" && tab.external) host.close?.(id);
    },
    stop: () => {
      stopped = true;
    },
  };
}

let current: ReturnType<typeof createExternalBrowserSync> | undefined;

export async function startExternalBrowserSync(host: Host) {
  // This page's browser session first: starting it lets go of the bindings
  // the last page left, which name its tab ids and refused this page's binds
  // after a reload (round 60).
  await beginBrowserSession().catch(() => {});
  const service = createExternalBrowserSync({
    shown: externalPaneShown,
    ...host,
    publish: (connections) =>
      useExternalBrowsers.getState().setConnections(connections),
  });
  current = service;
  let stopListening: (() => void) | undefined;
  let stopReads: (() => void) | undefined;
  let stopTurns: (() => void) | undefined;
  let stopClosed: (() => void) | undefined;
  try {
    stopListening = await listen("anbo:external-browser-changed", () => {
      void service.refresh().catch(() => {});
    });
    stopClosed = await listen<{ tabId: number }>(
      "anbo:external-browser-closed",
      ({ payload }) => service.closedInBrowser(payload.tabId),
    );
    // An agent open's read is done: its tab may dock now.
    stopReads = await listen<{ tabId: number }>(
      "anbo:browser-dock-hold-release",
      ({ payload }) => releaseDockForOpenRead(payload.tabId),
    );
    stopTurns = await listen<{ tabId: number | null }>(
      POINTER_TURN_EVENT,
      ({ payload }) => setPointerTurn(payload.tabId),
    );
    await service.refresh();
  } catch (cause) {
    stopListening?.();
    stopClosed?.();
    stopReads?.();
    stopTurns?.();
    service.stop();
    if (current === service) current = undefined;
    void warn(`external browser sync did not start: ${String(cause)}`).catch(
      () => {},
    );
    throw cause;
  }
  return () => {
    stopListening?.();
    stopClosed?.();
    stopReads?.();
    stopTurns?.();
    setPointerTurn(null);
    service.stop();
    if (current === service) {
      current = undefined;
      useExternalBrowsers.getState().setConnections([]);
    }
  };
}

export function reconcileExternalBrowserTabs(tabs: Tab[]) {
  current?.reconcile(tabs);
}
const NOT_READY =
  "Browser connections are not ready; retry after Anbo finishes starting.";
function running() {
  if (!current) throw new Error(NOT_READY);
  return current;
}
/** Opens an agent's page in the workspace's approved Chrome or Edge profile
 *  (the one `profile` names, where several are approved), or returns null for
 *  Anbo's own browser. An open still waiting for another one of its profile at
 *  `deadline` is not started. Without the service (Anbo still starting, or its start
 *  failed) the page still opens in Anbo's browser, unless the agent named a
 *  profile, the workspace has an approved profile or it shows a Chrome or Edge
 *  tab: those wait for the service instead of switching logins. */
export async function openExternalBrowser(
  url: string,
  workspace: string,
  tabs: Tab[],
  spaceId: string,
  holdDock = false,
  profile?: string,
  deadline?: number,
) {
  if (current) return current.open(url, workspace, holdDock, profile, deadline);
  if (profile !== undefined || showsExternalTabs(tabs, spaceId))
    throw new Error(NOT_READY);
  const approvedHere = await invoke<ExternalConnection[]>(
    "browser_external_connections",
  ).then(
    (connections) =>
      connections.some((connection) => servesWorkspace(connection, workspace)),
    () => false,
  );
  if (approvedHere) throw new Error(NOT_READY);
  return null;
}
export async function openExternalBrowserInto(
  url: string,
  workspace: string,
  tabId: number,
  profile: ExternalConnection["profile"],
) {
  return running().openInto(url, workspace, tabId, profile);
}
export async function selectExternalBrowserTab(
  connectionId: string,
  browserTabId: number,
  url: string,
  workspace: string,
) {
  return running().select(connectionId, browserTabId, url, workspace);
}
/** The Anbo tab showing this selection, once it is bound. */
export function externalBrowserTabId(
  connectionId: string,
  selectionId: string,
): number | undefined {
  return current?.tabFor(connectionId, selectionId);
}
