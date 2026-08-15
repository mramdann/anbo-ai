import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Clock01Icon,
  Delete02Icon,
  FolderOpenIcon,
  Globe02Icon,
  HardDriveIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { isTauri } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import {
  BROWSER_HISTORY_EVENT,
  type BrowserHistoryEntry,
  clearBrowserHistory,
  readBrowserHistory,
  removeBrowserHistoryEntry,
} from "./history";
import {
  type BrowserDataUsage,
  browserClearData,
  browserDataUsage,
} from "./native";

type Props = {
  visible: boolean;
  onNavigate: (url: string) => void;
};

const EMPTY_USAGE: BrowserDataUsage = { bytes: 0, files: 0, complete: true };

export function BrowserStartPage({ visible, onNavigate }: Props) {
  const [history, setHistory] =
    useState<BrowserHistoryEntry[]>(readBrowserHistory);
  const [usage, setUsage] = useState<BrowserDataUsage | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [clearOpen, setClearOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [clearing, setClearing] = useState(false);

  const refreshUsage = useCallback(async () => {
    if (!isTauri()) {
      setUsage(EMPTY_USAGE);
      return;
    }
    try {
      setUsage(await browserDataUsage());
      setUsageError(null);
    } catch (error) {
      setUsageError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    const refreshHistory = () => setHistory(readBrowserHistory());
    window.addEventListener(BROWSER_HISTORY_EVENT, refreshHistory);
    return () =>
      window.removeEventListener(BROWSER_HISTORY_EVENT, refreshHistory);
  }, []);

  useEffect(() => {
    if (visible) void refreshUsage();
  }, [refreshUsage, visible]);

  const clearAll = async () => {
    setClearing(true);
    try {
      if (isTauri()) await browserClearData();
      clearBrowserHistory();
      setHistory([]);
      setClearOpen(false);
      window.setTimeout(() => void refreshUsage(), 350);
    } catch (error) {
      setUsageError(error instanceof Error ? error.message : String(error));
    } finally {
      setClearing(false);
    }
  };

  const recent = history.slice(0, 6);

  const removeHistoryEntry = (url: string) => {
    removeBrowserHistoryEntry(url);
    setHistory(readBrowserHistory());
  };

  return (
    <div className="h-full w-full overflow-y-auto bg-background">
      <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col justify-center gap-5 px-6 py-10">
        <div className="flex items-center gap-3">
          <div className="flex size-11 shrink-0 items-center justify-center rounded-2xl border border-border/60 bg-card text-muted-foreground shadow-sm">
            <HugeiconsIcon icon={Globe02Icon} size={20} strokeWidth={1.5} />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-foreground">
              New browser tab
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Search, enter a URL, choose a port, or open an HTML file from this
              workspace.
            </p>
          </div>
        </div>

        <div className="grid gap-3 md:grid-cols-[minmax(0,1.35fr)_minmax(230px,0.65fr)]">
          <section className="overflow-hidden rounded-xl border border-border/60 bg-card/80 shadow-sm">
            <div className="flex h-10 items-center gap-2 border-b border-border/50 px-3">
              <HugeiconsIcon
                icon={Clock01Icon}
                size={15}
                strokeWidth={1.6}
                className="text-muted-foreground"
              />
              <h3 className="text-xs font-medium text-foreground">
                Recent history
              </h3>
              <span className="ml-auto text-[10px] tabular-nums text-muted-foreground">
                {history.length} {history.length === 1 ? "page" : "pages"}
              </span>
              {history.length > 0 ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setHistoryOpen(true)}
                  className="h-6 px-2 text-[10px]"
                >
                  View all
                </Button>
              ) : null}
            </div>
            <div className="min-h-48 p-1.5">
              {recent.length === 0 ? (
                <div className="flex h-44 items-center justify-center px-4 text-center text-[11px] text-muted-foreground">
                  Pages you visit will appear here.
                </div>
              ) : (
                recent.map((entry) => (
                  <HistoryRow
                    key={entry.url}
                    entry={entry}
                    onNavigate={onNavigate}
                    onRemove={removeHistoryEntry}
                  />
                ))
              )}
            </div>
          </section>

          <section className="flex flex-col rounded-xl border border-border/60 bg-card/80 p-4 shadow-sm">
            <div className="flex items-center gap-2 text-muted-foreground">
              <HugeiconsIcon icon={HardDriveIcon} size={16} strokeWidth={1.6} />
              <h3 className="text-xs font-medium text-foreground">
                Browser data
              </h3>
            </div>
            <div className="mt-5 text-2xl font-semibold tracking-tight text-foreground">
              {usage ? formatBytes(usage.bytes) : "..."}
            </div>
            <p className="mt-1 text-[10.5px] leading-relaxed text-muted-foreground">
              {usage
                ? `${usage.files.toLocaleString()} profile files${usage.complete ? "" : ", approximate"}`
                : "Calculating the isolated browser profile size."}
            </p>
            {usageError ? (
              <p className="mt-2 break-words text-[10px] leading-relaxed text-destructive">
                {usageError}
              </p>
            ) : null}
            <div className="mt-auto pt-6">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setClearOpen(true)}
                className="h-8 w-full justify-start gap-2 text-[11px]"
              >
                <HugeiconsIcon
                  icon={Delete02Icon}
                  size={13}
                  strokeWidth={1.7}
                />
                Clear browsing data
              </Button>
              <p className="mt-2 text-[9.5px] leading-relaxed text-muted-foreground/80">
                Clear history, passwords, cookies and more from this profile.
              </p>
            </div>
          </section>
        </div>
      </div>

      <AlertDialog open={clearOpen} onOpenChange={setClearOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear browsing data?</AlertDialogTitle>
            <AlertDialogDescription>
              Clear history, passwords, cookies and more from this profile.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={clearing}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={clearing}
              onClick={() => void clearAll()}
            >
              {clearing ? "Clearing..." : "Clear data"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
        <DialogContent className="max-w-2xl gap-0 overflow-hidden p-0">
          <DialogHeader className="border-b border-border/60 px-5 py-4 text-left">
            <DialogTitle>Browsing history</DialogTitle>
            <DialogDescription>
              {history.length} {history.length === 1 ? "page" : "pages"} stored
              locally in Anbo.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[65vh] min-h-56 overflow-y-auto p-2">
            {history.length === 0 ? (
              <div className="flex min-h-52 items-center justify-center text-xs text-muted-foreground">
                No browsing history.
              </div>
            ) : (
              history.map((entry) => (
                <HistoryRow
                  key={entry.url}
                  entry={entry}
                  onNavigate={(url) => {
                    setHistoryOpen(false);
                    onNavigate(url);
                  }}
                  onRemove={removeHistoryEntry}
                />
              ))
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function HistoryRow({
  entry,
  onNavigate,
  onRemove,
}: {
  entry: BrowserHistoryEntry;
  onNavigate: (url: string) => void;
  onRemove: (url: string) => void;
}) {
  return (
    <div className="group flex items-center rounded-lg hover:bg-accent">
      <button
        type="button"
        onClick={() => onNavigate(entry.url)}
        className="flex min-w-0 flex-1 items-center gap-2.5 px-2.5 py-2 text-left"
      >
        <div className="flex size-7 shrink-0 items-center justify-center rounded-lg border border-border/50 bg-background text-muted-foreground group-hover:text-foreground">
          <HugeiconsIcon
            icon={entry.url.startsWith("file:") ? FolderOpenIcon : Globe02Icon}
            size={13}
            strokeWidth={1.6}
          />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[11.5px] font-medium text-foreground">
            {entry.title}
          </div>
          <div className="truncate text-[10px] text-muted-foreground">
            {displayUrl(entry.url)}
          </div>
        </div>
        <time className="shrink-0 text-[9.5px] text-muted-foreground/80">
          {formatVisitTime(entry.visitedAt)}
        </time>
      </button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={() => onRemove(entry.url)}
        title="Remove from history"
        aria-label={`Remove ${entry.title} from history`}
        className="mr-1 size-7 shrink-0 text-muted-foreground opacity-60 hover:text-destructive group-hover:opacity-100 focus-visible:opacity-100"
      >
        <HugeiconsIcon icon={Delete02Icon} size={13} strokeWidth={1.7} />
      </Button>
    </div>
  );
}

function displayUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol === "file:")
      return decodeURIComponent(url.pathname).replace(
        /^\/(?:([A-Za-z]:))/,
        "$1",
      );
    return `${url.hostname}${url.pathname === "/" ? "" : url.pathname}`;
  } catch {
    return value;
  }
}

function formatVisitTime(value: number): string {
  const elapsed = Math.max(0, Date.now() - value);
  if (elapsed < 60_000) return "now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h`;
  return new Date(value).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1_024;
  let unit = 0;
  while (value >= 1_024 && unit < units.length - 1) {
    value /= 1_024;
    unit += 1;
  }
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${units[unit]}`;
}
