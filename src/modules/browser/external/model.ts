export type ExternalBrowser = {
  browser: "chrome" | "edge";
  profileId: string;
  name: string;
  connectionId?: string;
  browserTabId?: number;
  selectionId?: string;
  connected?: boolean;
  error?: string;
};

export type ExternalConnection = {
  connectionId: string;
  profile: { profileId: string; browser: "chrome" | "edge"; name: string };
  workspace: string | null;
  /** The browser still runs extension files from before an Anbo update. */
  extensionOutdated?: boolean;
  tabs: {
    id: number;
    title: string;
    url: string;
    selectionId: string;
    loading: boolean;
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

export function selectionKey(
  connectionId: string,
  selectionId: string,
): string {
  return `${connectionId}:${selectionId}`;
}
