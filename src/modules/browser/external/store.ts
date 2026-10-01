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

export type BrowserProfile = ExternalConnection["profile"];

type ExternalBrowsersState = {
  connections: ExternalConnection[];
  menuOpen: boolean;
  /** Profiles folded open or shut in the menu, by profile ID. */
  expanded: Record<string, boolean>;
  /** New tab pages started from a profile in the menu, by Anbo tab ID. Their
   * first web page opens in that profile; every other new tab is Anbo's. */
  newTabProfiles: Record<number, BrowserProfile>;
  setConnections: (connections: ExternalConnection[]) => void;
  setMenuOpen: (open: boolean) => void;
  setExpanded: (profileId: string, open: boolean) => void;
  setNewTabProfile: (tabId: number, profile: BrowserProfile | null) => void;
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
  expanded: {},
  setExpanded: (profileId, open) =>
    set((state) => ({ expanded: { ...state.expanded, [profileId]: open } })),
  newTabProfiles: {},
  setNewTabProfile: (tabId, profile) =>
    set((state) => {
      if (!profile && state.newTabProfiles[tabId] === undefined) return state;
      const next = { ...state.newTabProfiles };
      if (profile) next[tabId] = profile;
      else delete next[tabId];
      return { newTabProfiles: next };
    }),
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

/** Whether the profile is approved for this workspace, so a page it opens
 * lands here. */
export function approvedHere(
  connection: ExternalConnection,
  workspaceRoot: string | null,
): boolean {
  return (
    workspaceRoot !== null &&
    connection.workspace !== null &&
    sameWorkspace(connection.workspace, workspaceRoot)
  );
}

/** "Chrome · Work". */
export function profileLabel(profile: BrowserProfile): string {
  return `${browserName(profile.browser)} · ${profile.name}`;
}

export function workspaceName(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || path;
}
