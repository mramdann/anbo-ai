export type ExternalBrowser = {
  browser: "chrome" | "edge";
  profileId: string;
  name: string;
  connectionId?: string;
  browserTabId?: number;
  selectionId?: string;
  connected?: boolean;
  /** Anbo is binding this tab to its browser's tab right now. */
  connecting?: boolean;
  error?: string;
};

export type ExternalConnection = {
  connectionId: string;
  profile: { profileId: string; browser: "chrome" | "edge"; name: string };
  /** The workspaces approved to use the profile; none while it waits for
   * approval. Each of its tabs in Anbo belongs to one of them. */
  workspaces: string[];
  /** The workspace each selected tab was last bound in, by selection, so a
   * new page binds it there again. */
  placed?: Record<string, string>;
  /** The browser still runs extension files from before an Anbo update. */
  extensionOutdated?: boolean;
  tabs: {
    id: number;
    title: string;
    url: string;
    selectionId: string;
    loading: boolean;
    /** A page Anbo drives opened this tab (a link, a script). */
    openedFrom?: {
      selectionId: string;
      /** The browser opened it behind its opener: a Ctrl or middle click. */
      background: boolean;
      /** An agent's click or key opened it. */
      agent: boolean;
    };
  }[];
};

export function savedExternalBrowser(
  value: unknown,
): ExternalBrowser | undefined {
  if (!value || typeof value !== "object") return;
  const item = value as Partial<ExternalBrowser>;
  if (
    (item.browser !== "chrome" && item.browser !== "edge") ||
    typeof item.profileId !== "string" ||
    !/^[a-f\d-]{36}$/i.test(item.profileId) ||
    typeof item.name !== "string" ||
    item.name.length > 64
  )
    return;
  return { browser: item.browser, profileId: item.profileId, name: item.name };
}

export function sameWorkspace(left: string, right: string): boolean {
  return (
    left.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() ===
    right.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
  );
}

/** Whether the profile is approved for this workspace, so its pages may show
 * there. */
export function servesWorkspace(
  connection: ExternalConnection,
  root: string | null,
): boolean {
  return (
    root !== null &&
    connection.workspaces.some((workspace) => sameWorkspace(workspace, root))
  );
}

export function selectionKey(
  connectionId: string,
  selectionId: string,
): string {
  return `${connectionId}:${selectionId}`;
}
