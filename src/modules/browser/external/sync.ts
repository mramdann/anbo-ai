import {
  type ExternalBrowser,
  type ExternalConnection,
  sameWorkspace,
  selectionKey,
} from "@/modules/browser/external/model";
import type { BrowserTab, Tab, TabPatch } from "@/modules/tabs/lib/useTabs";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

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
            saved?.id ?? host.create(remote.url, false, space.id, external);
          binding = {
            id,
            spaceId: space.id,
            connectionId: connection.connectionId,
            selectionId: remote.selectionId,
            seen: Boolean(saved),
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
        if (!stopped) await apply();
      }
    })().finally(() => {
      flight = undefined;
      if (dirty && !stopped) return refresh();
    });
    return flight;
  };

  const open = async (
    url: string,
    workspace: string,
  ): Promise<number | null> => {
    const ensureRunning = () => {
      if (stopped)
        throw new Error(
          "Browser synchronization stopped; retry from the current workspace. Actions were not replayed.",
        );
    };
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
      if (
        host
          .tabs()
          .some(
            (tab) =>
              tab.kind === "browser" &&
              tab.external &&
              tab.spaceId === space?.id,
          )
      )
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

  return {
    refresh,
    reconcile,
    open,
    stop: () => {
      stopped = true;
    },
  };
}

let current: ReturnType<typeof createExternalBrowserSync> | undefined;

export async function startExternalBrowserSync(host: Host) {
  const service = createExternalBrowserSync(host);
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
    throw cause;
  }
  return () => {
    stopListening?.();
    service.stop();
    if (current === service) current = undefined;
  };
}

export function reconcileExternalBrowserTabs(tabs: Tab[]) {
  current?.reconcile(tabs);
}
export async function openExternalBrowser(url: string, workspace: string) {
  if (!current)
    throw new Error(
      "Browser connections are not ready; retry after Anbo finishes starting.",
    );
  return current.open(url, workspace);
}
