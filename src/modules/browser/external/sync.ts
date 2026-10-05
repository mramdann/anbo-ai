import {
  type ExternalBrowser,
  type ExternalConnection,
  sameWorkspace,
  selectionKey,
} from "@/modules/browser/external/model";
import { useExternalBrowsers } from "@/modules/browser/external/store";
import type { BrowserTab, Tab, TabPatch } from "@/modules/tabs/lib/useTabs";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { warn } from "@tauri-apps/plugin-log";

type Space = { id: string; root: string | null };
type Host = {
  tabs: () => Tab[];
  spaces: () => Space[];
  create: (
    url: string,
    activate: boolean,
    spaceId: string,
    external: ExternalBrowser,
  ) => number;
  update: (id: number, patch: TabPatch) => void;
  warm: (id: number) => void;
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
  // Opens and selections run one at a time, so a waiting selection is always
  // the one being opened.
  let queue: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(run: () => Promise<T>): Promise<T> => {
    const next = queue.catch(() => {}).then(run);
    queue = next;
    return next;
  };
  const externalTabs = (tabs: Tab[]) =>
    new Map(
      tabs.flatMap((tab) =>
        tab.kind === "browser" && tab.external
          ? [[tab.id, tab.external] as const]
          : [],
      ),
    );
  let knownTabs = externalTabs(host.tabs());

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
      released.add(key);
      bindings.delete(key);
      if (!tab) forgotten.add(binding.id);
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
      }).catch(() => {});
    }
    for (const [id, external] of knownTabs) {
      if (!nextTabs.has(id) && !forgotten.has(id))
        void call("browser_external_unbind", {
          tabId: id,
          connectionId: external.connectionId,
          selectionId: external.selectionId,
          forget: true,
        }).catch(() => {});
    }
    knownTabs = nextTabs;
  };

  const apply = async () => {
    const selected = new Set(
      connections
        .filter(
          (connection) =>
            connection.workspace &&
            host
              .spaces()
              .some(
                (space) =>
                  space.root &&
                  sameWorkspace(space.root, connection.workspace as string),
              ),
        )
        .flatMap((connection) =>
          connection.tabs
            .filter((tab) => tab.selectionId)
            .map((tab) =>
              selectionKey(connection.connectionId, tab.selectionId),
            ),
        ),
    );
    for (const [key, binding] of bindings) {
      if (selected.has(key)) continue;
      bindings.delete(key);
      const tab = host.tabs().find((tab) => tab.id === binding.id);
      if (tab?.kind === "browser" && tab.external)
        host.update(tab.id, {
          loading: false,
          external: { ...tab.external, connected: false },
        });
    }
    for (const connection of connections) {
      if (!connection.workspace) continue;
      const space = host
        .spaces()
        .find(
          (space) =>
            space.root !== null &&
            sameWorkspace(space.root, connection.workspace as string),
        );
      if (!space) continue;
      for (const remote of connection.tabs) {
        if (!remote.selectionId) continue;
        const key = selectionKey(connection.connectionId, remote.selectionId);
        if (released.has(key)) continue;
        let binding = bindings.get(key);
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
          if (!claimedTab && opening.has(connection.connectionId)) continue;
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
          const id =
            claimedTab?.id ??
            saved?.id ??
            host.create(remote.url, false, space.id, external);
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
                workspace: connection.workspace,
              },
            });
            if (stopped) return;
            reconcile();
            if (bindings.get(key) !== binding) continue;
            binding.ready = true;
            external.connected = true;
            host.warm(id);
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
          previous.external?.error === external.error;
        host.update(binding.id, {
          url: remote.url,
          title: remote.title || remote.url,
          loading: remote.loading,
          ...(!unchanged && { external }),
        });
      }
    }
    for (const key of released) if (!selected.has(key)) released.delete(key);
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

  const open = (url: string, workspace: string) =>
    exclusive(() => openNow(url, workspace));

  const openNow = async (
    url: string,
    workspace: string,
  ): Promise<number | null> => {
    ensureRunning();
    await refresh();
    ensureRunning();
    const profiles = connections.filter(
      (connection) =>
        connection.workspace && sameWorkspace(connection.workspace, workspace),
    );
    if (profiles.length > 1)
      throw new Error(
        "Several browser profiles are approved here. Use a selected tab ID or disconnect the unused profile before opening a tab.",
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
    const connection = profiles[0];
    const remote = await call<{ selectionId: string }>(
      "browser_external_open_tab",
      { connectionId: connection.connectionId, url, activate: false },
    );
    ensureRunning();
    await refresh();
    ensureRunning();
    const binding = bindings.get(
      selectionKey(connection.connectionId, remote.selectionId),
    );
    if (!binding?.ready)
      throw new Error(
        "The browser tab opened but could not bind to Anbo. Check browser connections; the action was not replayed.",
      );
    return binding.id;
  };

  /** Opens a page in a profile approved for the workspace and turns this Anbo
   * tab (a new tab page started from that profile) into that page, rather
   * than adding another tab. */
  const openInto = (
    url: string,
    workspace: string,
    tabId: number,
    profile: ExternalConnection["profile"],
  ) =>
    exclusive(async () => {
      ensureRunning();
      await refresh();
      ensureRunning();
      const connection = connections.find(
        (connection) =>
          connection.workspace &&
          sameWorkspace(connection.workspace, workspace) &&
          connection.profile.browser === profile.browser &&
          connection.profile.profileId === profile.profileId,
      );
      if (!connection)
        throw new Error(
          "This profile is not connected to this workspace. Reconnect it from the browser menu, or use Anbo's browser.",
        );
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

  /** Brings a tab the profile already has into Anbo. */
  const select = (connectionId: string, browserTabId: number, url: string) =>
    exclusive(async () => {
      ensureRunning();
      const remote = await call<{ selectionId: string }>(
        "browser_external_select_tab",
        { connectionId, tabId: browserTabId, expectedUrl: url },
      );
      ensureRunning();
      await refresh();
      ensureRunning();
      const binding = bindings.get(
        selectionKey(connectionId, remote.selectionId),
      );
      if (!binding?.ready)
        throw new Error(
          "The tab connected but could not open in Anbo. Try again from the browser menu.",
        );
      return binding.id;
    });

  return {
    refresh,
    reconcile,
    open,
    openInto,
    select,
    tabFor: (connectionId: string, selectionId: string) =>
      bindings.get(selectionKey(connectionId, selectionId))?.id,
    stop: () => {
      stopped = true;
    },
  };
}

let current: ReturnType<typeof createExternalBrowserSync> | undefined;

export async function startExternalBrowserSync(host: Host) {
  const service = createExternalBrowserSync({
    ...host,
    publish: (connections) =>
      useExternalBrowsers.getState().setConnections(connections),
  });
  current = service;
  let stopListening: (() => void) | undefined;
  try {
    stopListening = await listen("anbo:external-browser-changed", () => {
      void service.refresh().catch(() => {});
    });
    await service.refresh();
  } catch (cause) {
    stopListening?.();
    service.stop();
    if (current === service) current = undefined;
    void warn(`external browser sync did not start: ${String(cause)}`).catch(
      () => {},
    );
    throw cause;
  }
  return () => {
    stopListening?.();
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
/** Opens an agent's page in the workspace's approved Chrome or Edge profile,
 *  or returns null for Anbo's own browser. Without the service (Anbo still
 *  starting, or its start failed) the page still opens in Anbo's browser,
 *  unless the workspace has an approved profile or shows a Chrome or Edge
 *  tab: those wait for the service instead of switching logins. */
export async function openExternalBrowser(
  url: string,
  workspace: string,
  tabs: Tab[],
  spaceId: string,
) {
  if (current) return current.open(url, workspace);
  if (showsExternalTabs(tabs, spaceId)) throw new Error(NOT_READY);
  const approvedHere = await invoke<ExternalConnection[]>(
    "browser_external_connections",
  ).then(
    (connections) =>
      connections.some(
        (connection) =>
          connection.workspace !== null &&
          sameWorkspace(connection.workspace, workspace),
      ),
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
) {
  return running().select(connectionId, browserTabId, url);
}
/** The Anbo tab showing this selection, once it is bound. */
export function externalBrowserTabId(
  connectionId: string,
  selectionId: string,
): number | undefined {
  return current?.tabFor(connectionId, selectionId);
}
