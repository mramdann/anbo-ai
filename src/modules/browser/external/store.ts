import { IS_WINDOWS } from "@/lib/platform";
import {
  type ExternalConnection,
  sameWorkspace,
} from "@/modules/browser/external/model";
import { isTauri } from "@tauri-apps/api/core";
import { create } from "zustand";

/** Chrome and Edge profiles are a Windows development preview. */
export const EXTERNAL_BROWSERS_ENABLED =
  import.meta.env.DEV && IS_WINDOWS && isTauri();

type ExternalBrowsersState = {
  connections: ExternalConnection[];
  menuOpen: boolean;
  setConnections: (connections: ExternalConnection[]) => void;
  setMenuOpen: (open: boolean) => void;
};

export const useExternalBrowsers = create<ExternalBrowsersState>((set) => ({
  connections: [],
  menuOpen: false,
  // Tab titles and loading flags change often; an identical list is no news.
  setConnections: (connections) =>
    set((state) =>
      JSON.stringify(state.connections) === JSON.stringify(connections)
        ? state
        : { connections },
    ),
  setMenuOpen: (menuOpen) => set({ menuOpen }),
}));

export function browserName(browser: "chrome" | "edge"): string {
  return browser === "edge" ? "Edge" : "Chrome";
}

/** Profiles that connected and wait for someone to approve them. */
export function pendingConnections(
  connections: ExternalConnection[],
): ExternalConnection[] {
  return connections.filter((connection) => !connection.workspace);
}

/** The profile approved for this workspace. With none or several there is no
 * default, the same rule agents follow when they open a page. */
export function approvedConnection(
  connections: ExternalConnection[],
  workspaceRoot: string | null,
): ExternalConnection | null {
  if (!workspaceRoot) return null;
  const approved = connections.filter(
    (connection) =>
      connection.workspace !== null &&
      sameWorkspace(connection.workspace, workspaceRoot),
  );
  return approved.length === 1 ? approved[0] : null;
}

/** "Chrome · Work" for the workspace's profile, or null. */
export function approvedBrowserLabel(
  connections: ExternalConnection[],
  workspaceRoot: string | null,
): string | null {
  const connection = approvedConnection(connections, workspaceRoot);
  return connection
    ? `${browserName(connection.profile.browser)} · ${connection.profile.name}`
    : null;
}

export function workspaceName(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || path;
}
