import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { BrowserLogo } from "@/modules/browser/external/BrowserLogo";
import {
  BrowserSetupInstructions,
  type BrowserSetupResult,
  type SetupCopy,
} from "@/modules/browser/external/BrowserSetupInstructions";
import {
  type ExternalConnection,
  sameWorkspace,
} from "@/modules/browser/external/model";
import {
  browserName,
  pendingConnections,
  useExternalBrowsers,
  workspaceName,
} from "@/modules/browser/external/store";
import {
  externalBrowserTabId,
  selectExternalBrowserTab,
} from "@/modules/browser/external/sync";
import {
  AiWebBrowsingIcon,
  ArrowRight01Icon,
  ArrowUpRight01Icon,
  Globe02Icon,
  Refresh01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { invoke } from "@tauri-apps/api/core";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

type Props = {
  workspaceRoot: string | null;
  onShowTab: (tabId: number) => void;
  onCloseTab: (tabId: number) => void;
};

type BrowserTabInfo = { id: number; title: string; url: string };
type TabList = BrowserTabInfo[] | { error: string };

function host(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/** Tabs of the profile that are not in Anbo yet. */
export function otherTabs(
  connection: ExternalConnection,
  list: BrowserTabInfo[],
): BrowserTabInfo[] {
  const inAnbo = new Set(connection.tabs.map((tab) => tab.id));
  return list.filter((tab) => !inAnbo.has(tab.id));
}

/** The header's few words on the profiles: how many are connected, and how
 * many wait for approval. */
export function profileSummary(connected: number, waiting: number): string {
  const parts: string[] = [];
  if (connected > 0)
    parts.push(
      `${connected} ${connected === 1 ? "profile" : "profiles"} connected`,
    );
  if (waiting > 0) parts.push(`${waiting} waiting`);
  return parts.length > 0 ? parts.join(" · ") : "Not connected";
}

/** The header button's name, which also says why its badge is up. */
export function menuLabel(connected: number, waiting: number): string {
  if (waiting > 0)
    return `External browsers: ${waiting === 1 ? "a profile is" : `${waiting} profiles are`} waiting for approval`;
  return connected > 0
    ? `External browsers: ${profileSummary(connected, 0)}`
    : "External browsers: connect Chrome or Edge";
}

export default function ExternalBrowserMenu({
  workspaceRoot,
  onShowTab,
  onCloseTab,
}: Props) {
  const open = useExternalBrowsers((state) => state.menuOpen);
  const setOpen = useExternalBrowsers((state) => state.setMenuOpen);
  const total = useExternalBrowsers((state) => state.connections.length);
  const waiting = useExternalBrowsers(
    (state) => pendingConnections(state.connections).length,
  );
  const connectedHere = useExternalBrowsers(
    (state) =>
      workspaceRoot !== null &&
      state.connections.some(
        (connection) =>
          connection.workspace !== null &&
          sameWorkspace(connection.workspace, workspaceRoot),
      ),
  );
  const label = menuLabel(total - waiting, waiting);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative size-6 shrink-0 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          title={label}
          aria-label={label}
        >
          <HugeiconsIcon
            icon={AiWebBrowsingIcon}
            size={14}
            strokeWidth={1.75}
            className="size-3.5"
          />
          {waiting > 0 ? (
            <span
              aria-hidden
              className="absolute -top-0.5 -right-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-0.5 text-[9px] font-semibold leading-none text-primary-foreground"
            >
              {waiting > 9 ? "9+" : waiting}
            </span>
          ) : connectedHere ? (
            <span
              aria-hidden
              className="absolute right-0.5 bottom-0.5 size-1.5 rounded-full bg-emerald-500 ring-2 ring-card"
            />
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        className="w-80 gap-0 overflow-hidden rounded-xl p-0 [zoom:var(--app-zoom)]"
      >
        {open ? (
          <OpenMenu
            workspaceRoot={workspaceRoot}
            onShowTab={(id) => {
              onShowTab(id);
              setOpen(false);
            }}
            onCloseTab={onCloseTab}
          />
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

// Only an open menu follows every change to the connected tabs.
function OpenMenu(props: Props) {
  const connections = useExternalBrowsers((state) => state.connections);
  return <MenuBody connections={connections} {...props} />;
}

export function MenuBody({
  connections,
  workspaceRoot,
  onShowTab,
  onCloseTab,
}: Props & { connections: ExternalConnection[] }) {
  const pending = connections.filter((connection) => !connection.workspace);
  const approved = connections.filter((connection) => connection.workspace);
  const folded = useExternalBrowsers((state) => state.expanded);
  const setFolded = useExternalBrowsers((state) => state.setExpanded);
  const [lists, setLists] = useState<Record<string, TabList>>({});
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sequence = useRef(0);
  // Only a change in which tabs are in Anbo asks the browsers again; titles
  // and loading flags change far more often.
  const listKey = approved
    .map(
      (connection) =>
        `${connection.connectionId}\t${connection.tabs.map((tab) => tab.id).join(",")}`,
    )
    .join("\n");

  const loadTabs = useCallback(async () => {
    const request = ++sequence.current;
    const ids = listKey
      ? listKey.split("\n").map((entry) => entry.split("\t")[0])
      : [];
    setLoading(true);
    const entries = await Promise.all(
      ids.map(async (connectionId) => {
        try {
          const tabs = await invoke<BrowserTabInfo[]>(
            "browser_external_list_tabs",
            { connectionId },
          );
          return [connectionId, tabs] as const;
        } catch (cause) {
          return [connectionId, { error: String(cause) }] as const;
        }
      }),
    );
    if (request !== sequence.current) return;
    setLists(Object.fromEntries(entries));
    setLoading(false);
  }, [listKey]);

  useEffect(() => {
    void loadTabs();
    return () => {
      sequence.current += 1;
    };
  }, [loadTabs]);

  const act = async (key: string, run: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await run();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div className="flex h-8 items-center gap-2 px-2.5">
        <span className="shrink-0 text-xs font-medium text-foreground">
          External browsers
        </span>
        <span className="min-w-0 truncate text-[10.5px] text-muted-foreground">
          {profileSummary(approved.length, pending.length)}
        </span>
        {approved.length > 0 ? (
          <button
            type="button"
            title="Refresh tabs"
            disabled={loading}
            onClick={() => void loadTabs()}
            className="ml-auto rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
          >
            <HugeiconsIcon icon={Refresh01Icon} size={12} strokeWidth={1.75} />
          </button>
        ) : null}
      </div>
      <div className="max-h-[min(70vh,30rem)] overflow-y-auto border-t border-border/60 p-1">
        {pending.length > 0 ? <Heading>Needs approval</Heading> : null}
        {pending.map((connection) => (
          <ApprovalCard
            key={connection.connectionId}
            connection={connection}
            workspaceRoot={workspaceRoot}
            busy={busy !== null}
            onApprove={() =>
              void act(`approve:${connection.connectionId}`, async () => {
                await invoke("browser_external_approve", {
                  connectionId: connection.connectionId,
                  workspace: workspaceRoot,
                });
              })
            }
            onDeny={() =>
              void act(`deny:${connection.connectionId}`, async () => {
                await invoke("browser_external_disconnect", {
                  connectionId: connection.connectionId,
                });
              })
            }
          />
        ))}
        {approved.map((connection) => {
          // One profile starts open; with several, each starts folded.
          const expanded =
            folded[connection.profile.profileId] ?? approved.length === 1;
          return (
            <ProfileSection
              key={connection.connectionId}
              connection={connection}
              workspaceRoot={workspaceRoot}
              list={lists[connection.connectionId]}
              busy={busy}
              expanded={expanded}
              onToggle={() =>
                setFolded(connection.profile.profileId, !expanded)
              }
              onDisconnect={() =>
                void act(`disconnect:${connection.connectionId}`, async () => {
                  await invoke("browser_external_disconnect", {
                    connectionId: connection.connectionId,
                  });
                })
              }
              onShow={(selectionId) => {
                const id = externalBrowserTabId(
                  connection.connectionId,
                  selectionId,
                );
                if (id === undefined)
                  setError(
                    "This tab is still connecting. Try again in a moment.",
                  );
                else onShowTab(id);
              }}
              onReturn={(tab) =>
                void act(`return:${tab.selectionId}`, async () => {
                  const id = externalBrowserTabId(
                    connection.connectionId,
                    tab.selectionId,
                  );
                  // Released first, so closing the Anbo tab keeps the page
                  // open in the browser even when Anbo opened it.
                  await invoke("browser_external_release_tab", {
                    connectionId: connection.connectionId,
                    tabId: tab.id,
                  });
                  if (id !== undefined) onCloseTab(id);
                })
              }
              onOpen={(tab) =>
                void act(
                  `open:${connection.connectionId}:${tab.id}`,
                  async () => {
                    onShowTab(
                      await selectExternalBrowserTab(
                        connection.connectionId,
                        tab.id,
                        tab.url,
                      ),
                    );
                  },
                )
              }
            />
          );
        })}
        {connections.length === 0 ? (
          <p className="px-3 py-4 text-center text-[11px] leading-relaxed text-muted-foreground">
            Use your Chrome or Edge logins in Anbo. Pages stay in your browser;
            Anbo shows and controls only the tabs opened here.
          </p>
        ) : null}
      </div>
      {error ? (
        <p
          role="alert"
          className="border-t border-border/60 px-3 py-2 text-[11px] break-words text-destructive"
        >
          {error}
        </p>
      ) : null}
      <SetupSection connected={connections.length > 0} />
    </>
  );
}

function Heading({ children }: { children: ReactNode }) {
  return (
    <div className="px-1.5 pt-1.5 pb-0.5 text-[10px] font-medium tracking-wide text-muted-foreground/70 uppercase">
      {children}
    </div>
  );
}

function ProfileMark({ browser }: { browser: "chrome" | "edge" }) {
  return (
    <span className="flex size-6 shrink-0 items-center justify-center rounded-md border border-border/60 bg-background">
      <BrowserLogo browser={browser} />
    </span>
  );
}

function ApprovalCard({
  connection,
  workspaceRoot,
  busy,
  onApprove,
  onDeny,
}: {
  connection: ExternalConnection;
  workspaceRoot: string | null;
  busy: boolean;
  onApprove: () => void;
  onDeny: () => void;
}) {
  const browser = browserName(connection.profile.browser);
  return (
    <div className="mx-0.5 mb-1 rounded-lg border border-primary/25 bg-primary/5 p-2.5">
      <div className="flex items-center gap-2">
        <ProfileMark browser={connection.profile.browser} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium text-foreground">
            {connection.profile.name}
          </p>
          <p className="text-[10.5px] text-muted-foreground">
            Wants to connect
          </p>
        </div>
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
        This workspace can then list the profile's tabs and control the ones
        open in Anbo. Logins stay in {browser}.
      </p>
      <div className="mt-2 flex items-center gap-1.5">
        <Button
          size="xs"
          disabled={busy || !workspaceRoot}
          onClick={onApprove}
          className="min-w-0"
        >
          <span className="truncate">
            {workspaceRoot
              ? `Approve for ${workspaceName(workspaceRoot)}`
              : "Open a workspace to approve"}
          </span>
        </Button>
        <Button size="xs" variant="ghost" disabled={busy} onClick={onDeny}>
          Deny
        </Button>
      </div>
    </div>
  );
}

function ProfileSection({
  connection,
  workspaceRoot,
  list,
  busy,
  expanded,
  onToggle,
  onDisconnect,
  onShow,
  onReturn,
  onOpen,
}: {
  connection: ExternalConnection;
  workspaceRoot: string | null;
  list: TabList | undefined;
  busy: string | null;
  expanded: boolean;
  onToggle: () => void;
  onDisconnect: () => void;
  onShow: (selectionId: string) => void;
  onReturn: (tab: ExternalConnection["tabs"][number]) => void;
  onOpen: (tab: BrowserTabInfo) => void;
}) {
  const browser = browserName(connection.profile.browser);
  const elsewhere =
    connection.workspace !== null &&
    (!workspaceRoot || !sameWorkspace(connection.workspace, workspaceRoot));
  const others = Array.isArray(list) ? otherTabs(connection, list) : [];
  return (
    <section className="mb-0.5">
      {/* The lists show what the profile has, so the row keeps only its
          name and Disconnect. */}
      <div className="flex items-center rounded-md transition-colors hover:bg-accent">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-2 px-1.5 py-1.5 text-left"
        >
          <HugeiconsIcon
            icon={ArrowRight01Icon}
            size={12}
            strokeWidth={1.75}
            className={cn(
              "shrink-0 text-muted-foreground transition-transform",
              expanded && "rotate-90",
            )}
          />
          <BrowserLogo browser={connection.profile.browser} />
          <span className="min-w-0 truncate text-xs font-medium text-foreground">
            {connection.profile.name}
          </span>
          {elsewhere && connection.workspace ? (
            <span className="shrink-0 text-[10.5px] text-muted-foreground">
              {workspaceName(connection.workspace)}
            </span>
          ) : null}
        </button>
        <button
          type="button"
          disabled={busy !== null}
          onClick={onDisconnect}
          className="mr-1 shrink-0 rounded-md px-1.5 py-0.5 text-[10.5px] text-muted-foreground transition-colors hover:bg-background hover:text-foreground disabled:opacity-50"
        >
          Disconnect
        </button>
      </div>
      {expanded ? (
        <div className="pb-1 pl-4">
          <Heading>In Anbo</Heading>
          {connection.tabs.length === 0 ? (
            <p className="px-1.5 pb-1 text-[11px] leading-relaxed text-muted-foreground">
              Nothing yet. Open one of the tabs below, or a new browser tab in
              Anbo.
            </p>
          ) : (
            connection.tabs.map((tab) => (
              <TabRow
                key={tab.selectionId}
                title={tab.title}
                url={tab.url}
                label={`Show ${tab.title || host(tab.url)}`}
                disabled={busy !== null}
                onClick={() => onShow(tab.selectionId)}
                action={
                  <button
                    type="button"
                    title={`Return to ${browser}`}
                    aria-label={`Return ${tab.title || host(tab.url)} to ${browser}`}
                    disabled={busy !== null}
                    onClick={() => onReturn(tab)}
                    className="mr-1 shrink-0 rounded-md p-1 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:bg-background hover:text-foreground focus-visible:opacity-100 disabled:opacity-40"
                  >
                    <HugeiconsIcon
                      icon={ArrowUpRight01Icon}
                      size={12}
                      strokeWidth={1.75}
                    />
                  </button>
                }
              />
            ))
          )}
          <Heading>Other tabs</Heading>
          {list === undefined ? (
            <p className="px-1.5 pb-1 text-[11px] text-muted-foreground">
              Loading tabs...
            </p>
          ) : !Array.isArray(list) ? (
            <p className="px-1.5 pb-1 text-[11px] break-words text-destructive">
              {list.error}
            </p>
          ) : others.length === 0 ? (
            <p className="px-1.5 pb-1 text-[11px] text-muted-foreground">
              No other web tabs.
            </p>
          ) : (
            <div className="max-h-44 overflow-y-auto">
              {others.map((tab) => (
                <TabRow
                  key={tab.id}
                  title={tab.title}
                  url={tab.url}
                  label={`Open ${tab.title || host(tab.url)} in Anbo`}
                  disabled={busy !== null}
                  onClick={() => onOpen(tab)}
                  hint={
                    busy === `open:${connection.connectionId}:${tab.id}`
                      ? "Opening..."
                      : "Open"
                  }
                />
              ))}
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}

export function TabRow({
  title,
  url,
  label,
  disabled,
  onClick,
  hint,
  action,
}: {
  title: string;
  url: string;
  label: string;
  disabled: boolean;
  onClick: () => void;
  /** Shown on hover inside the row's button, so it clicks like the row. */
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="group flex items-center rounded-md transition-colors hover:bg-accent">
      <button
        type="button"
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
        className="flex min-w-0 flex-1 items-center gap-2 px-1.5 py-1 text-left disabled:opacity-60"
      >
        <HugeiconsIcon
          icon={Globe02Icon}
          size={13}
          strokeWidth={1.6}
          className="shrink-0 text-muted-foreground"
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs text-foreground">
            {title || host(url)}
          </span>
          <span className="block truncate text-[10.5px] text-muted-foreground">
            {host(url)}
          </span>
        </span>
        {hint ? (
          <span className="shrink-0 text-[10.5px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
            {hint}
          </span>
        ) : null}
      </button>
      {action}
    </div>
  );
}

function SetupSection({ connected }: { connected: boolean }) {
  const [expanded, setOpen] = useState(false);
  const open = expanded || !connected;
  const [installing, setInstalling] = useState<"chrome" | "edge" | null>(null);
  const [setup, setSetup] = useState<BrowserSetupResult | null>(null);
  const [copied, setCopied] = useState<SetupCopy | null>(null);
  const [error, setError] = useState<string | null>(null);

  const install = async (browser: "chrome" | "edge") => {
    setInstalling(browser);
    setError(null);
    setCopied(null);
    setSetup(null);
    try {
      setSetup(
        await invoke<BrowserSetupResult>("browser_external_setup", { browser }),
      );
    } catch (cause) {
      setError(String(cause));
    } finally {
      setInstalling(null);
    }
  };

  const copy = async (what: SetupCopy) => {
    if (!setup) return;
    try {
      await navigator.clipboard.writeText(
        what === "address" ? setup.extensionsUrl : setup.extensionPath,
      );
      setCopied(what);
    } catch {
      setError(
        what === "address"
          ? `Could not copy the address. Type ${setup.extensionsUrl} into the address bar.`
          : "Could not copy the folder path. Select and copy the path shown above.",
      );
    }
  };

  if (!open)
    return (
      <div className="border-t border-border/60 p-1">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <span className="flex size-4 items-center justify-center text-sm leading-none">
            +
          </span>
          Connect Chrome or Edge
        </button>
      </div>
    );
  return (
    <div className="grid gap-2 border-t border-border/60 p-2.5 text-xs">
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        Setup installs the bridge for this Anbo and opens the browser's
        extensions page. Logins are never copied.
      </p>
      <div className="flex gap-1.5">
        {(["chrome", "edge"] as const).map((browser) => (
          <Button
            key={browser}
            size="xs"
            variant="outline"
            disabled={installing !== null}
            onClick={() => void install(browser)}
          >
            {installing === browser
              ? "Setting up..."
              : `Set up ${browserName(browser)}`}
          </Button>
        ))}
      </div>
      {installing ? (
        <p role="status" className="text-[11px] text-muted-foreground">
          Installing the bridge for this Windows user. This may take a moment.
        </p>
      ) : null}
      {setup ? (
        <div className="max-h-72 overflow-y-auto">
          <BrowserSetupInstructions
            setup={setup}
            copied={copied}
            onCopy={(what) => void copy(what)}
          />
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-[11px] break-words text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
