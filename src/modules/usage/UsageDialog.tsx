import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import {
  type SpaceRunState,
  spaceRunState,
} from "@/modules/spaces/lib/pauseSpace";
import { useSpaces } from "@/modules/spaces/lib/useSpaces";
import { SpaceAvatar } from "@/modules/spaces/SpaceAvatar";
import type { Tab } from "@/modules/tabs/lib/useTabs";
import {
  Activity01Icon,
  AiBrain01Icon,
  ArrowDown01Icon,
  ArrowRight01Icon,
  ChromeIcon,
  CodeIcon,
  ComputerTerminal01Icon,
  CpuIcon,
  Globe02Icon,
  PauseIcon,
  PlayIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMemo, useState } from "react";
import {
  formatCpu,
  formatMemory,
  type UsageRow,
  type WorkspaceUsage,
} from "./lib/usageModel";
import { useUsageModel } from "./lib/useUsageModel";
import { USAGE_INTERVAL_MS } from "./lib/useUsageSnapshot";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tabs: Tab[];
  /** Shows a tab, or an agent's pane in it. A tab that is not running starts. */
  onShowTab: (tabId: number, leafId?: number) => void;
  onPauseSpace: (spaceId: string) => void;
  onResumeSpace: (spaceId: string) => void;
};

type SortBy = "memory" | "cpu";

const ROW_ICONS = {
  agent: AiBrain01Icon,
  terminal: ComputerTerminal01Icon,
  browser: Globe02Icon,
  external: ChromeIcon,
  server: CodeIcon,
  anbo: CpuIcon,
} as const;

const GRID =
  "grid grid-cols-[minmax(0,1fr)_4.25rem_5rem_4.75rem] items-center gap-2";
// One class list for each kind of cell, shared by the totals and every row.
const NAME = "truncate text-[13px] font-medium text-foreground";
const NOTE = "truncate text-[11px] text-muted-foreground/70";
const FIGURE = "text-right text-[12px] tabular-nums text-muted-foreground";
const FIGURE_STRONG =
  "text-right text-[12px] font-medium tabular-nums text-foreground";

function metric(
  item: { memory: number | null; cpu: number | null },
  sortBy: SortBy,
): number {
  return (sortBy === "memory" ? item.memory : item.cpu) ?? -1;
}

function countsLine(workspace: WorkspaceUsage): string {
  const parts: string[] = [];
  const { agents, terminals, browserTabs } = workspace.counts;
  if (agents) parts.push(`${agents} agent${agents === 1 ? "" : "s"}`);
  if (terminals)
    parts.push(`${terminals} terminal${terminals === 1 ? "" : "s"}`);
  if (browserTabs)
    parts.push(`${browserTabs} tab${browserTabs === 1 ? "" : "s"}`);
  return parts.length ? parts.join(" · ") : "nothing running";
}

export function UsageDialog({
  open,
  onOpenChange,
  tabs,
  onShowTab,
  onPauseSpace,
  onResumeSpace,
}: Props) {
  // The sort stays from one opening to the next. Everything else lives in the
  // body, which exists only while the view is open (the dialog unmounts its
  // content when closed): closed, the view reads, watches and works out
  // nothing.
  const [sortBy, setSortBy] = useState<SortBy>("memory");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* data-usage-view: its overlay dims without a blur (globals.css). */}
      <DialogContent
        data-usage-view=""
        className="flex max-h-[85vh] flex-col gap-3 sm:max-w-3xl"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.75">
            <HugeiconsIcon icon={Activity01Icon} size={16} strokeWidth={1.75} />
            Task Manager
          </DialogTitle>
          <DialogDescription>
            Memory and CPU of each workspace's agents, terminals and browser
            tabs, read every {USAGE_INTERVAL_MS / 1000} seconds while this is
            open.
          </DialogDescription>
        </DialogHeader>
        <UsageBody
          tabs={tabs}
          sortBy={sortBy}
          onSortBy={setSortBy}
          onShowTab={onShowTab}
          onPauseSpace={onPauseSpace}
          onResumeSpace={onResumeSpace}
        />
      </DialogContent>
    </Dialog>
  );
}

type BodyProps = Omit<Props, "open" | "onOpenChange"> & {
  sortBy: SortBy;
  onSortBy: (sortBy: SortBy) => void;
};

function UsageBody({
  tabs,
  sortBy,
  onSortBy,
  onShowTab,
  onPauseSpace,
  onResumeSpace,
}: BodyProps) {
  // Mounted only while open; it keeps reading through the closing fade.
  const model = useUsageModel(tabs);
  const spaces = useSpaces((s) => s.spaces);
  const activeId = useSpaces((s) => s.activeId);
  // Every workspace starts folded: one line each, opened by a click.
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());

  const runStates = useMemo(() => {
    const states = new Map<string, SpaceRunState>();
    for (const space of spaces)
      states.set(space.id, spaceRunState(tabs, space.id));
    return states;
  }, [spaces, tabs]);

  const workspaces = useMemo(
    () =>
      model
        ? [...model.workspaces].sort(
            (a, b) =>
              metric(b, sortBy) - metric(a, sortBy) ||
              a.name.localeCompare(b.name),
          )
        : [],
    [model, sortBy],
  );

  const toggle = (spaceId: string) =>
    setOpened((current) => {
      const next = new Set(current);
      if (next.has(spaceId)) next.delete(spaceId);
      else next.add(spaceId);
      return next;
    });

  if (!model) {
    return (
      <p className="py-6 text-center text-[13px] text-muted-foreground">
        Reading…
      </p>
    );
  }
  if (!model.supported) {
    return (
      <p className="py-6 text-center text-[13px] text-muted-foreground">
        Task Manager is available on Windows only.
      </p>
    );
  }
  return (
    <>
      {/* The heads stand in the list's own width (its scrollbar gutter): outside
          it they stood a scrollbar's width to the right of the figures. */}
      <div className="panel-scrollbar -mx-1 -mb-1.5 shrink-0 overflow-hidden px-1 [scrollbar-gutter:stable]">
        <div className="mb-1.5 ml-auto flex w-fit items-center gap-0.5 rounded-md bg-muted/60 p-0.5">
          {(["memory", "cpu"] as const).map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => onSortBy(key)}
              className={cn(
                "rounded px-2 py-0.5 text-[11px] transition-colors",
                sortBy === key
                  ? "bg-background text-foreground shadow-xs"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {key === "memory" ? "By memory" : "By CPU"}
            </button>
          ))}
        </div>
        <div className={cn(GRID, "px-2 text-[11px] text-muted-foreground/70")}>
          <span>Name</span>
          <span className="text-right">CPU</span>
          <span className="text-right">Memory</span>
          <span />
        </div>
      </div>

      <div className="panel-scrollbar -mx-1 min-h-0 flex-1 overflow-y-auto px-1 [scrollbar-gutter:stable]">
        {/* Anbo against this computer, in the list's columns. They stay on top
            while the list scrolls; in a short window they scroll with it. */}
        <div className="top-0 z-10 mb-1 border-b border-border/60 bg-popover pb-1.5 [@media(min-height:34rem)]:sticky">
          <TotalRow
            name="Anbo"
            note="everything below"
            cpu={model.total.cpu}
            memory={model.total.memory}
          />
          <TotalRow
            name="This computer"
            cpu={model.machine.cpu}
            memory={model.machine.memoryUsed}
            of={model.machine.memoryTotal}
          />
        </div>
        {workspaces.map((workspace) => {
          const space = spaces.find((s) => s.id === workspace.spaceId);
          if (!space) return null;
          const isActive = workspace.spaceId === activeId;
          const runState = runStates.get(workspace.spaceId) ?? "idle";
          const isCollapsed = !opened.has(workspace.spaceId);
          const rows = workspace.rows
            .filter((row) => row.running)
            .sort((a, b) => metric(b, sortBy) - metric(a, sortBy));
          // Tabs that run nothing take one quiet line, not a row each.
          const idleRows = workspace.rows.filter((row) => !row.running);
          return (
            <section key={workspace.spaceId} className="mb-1">
              <div
                className={cn(
                  GRID,
                  "rounded-md px-2 py-1.5",
                  isActive ? "bg-accent" : "hover:bg-accent/50",
                )}
              >
                <button
                  type="button"
                  onClick={() => toggle(workspace.spaceId)}
                  className="flex min-w-0 items-center gap-2 text-left"
                  aria-expanded={!isCollapsed}
                >
                  <HugeiconsIcon
                    icon={isCollapsed ? ArrowRight01Icon : ArrowDown01Icon}
                    size={14}
                    strokeWidth={2}
                    className="shrink-0 text-muted-foreground/60"
                  />
                  <SpaceAvatar space={space} size="sm" active={isActive} />
                  <span className={NAME}>{workspace.name}</span>
                  {isActive && (
                    <span className="shrink-0 rounded bg-background/70 px-1 text-[10px] text-muted-foreground">
                      in view
                    </span>
                  )}
                  <span className={NOTE}>
                    {runState === "paused" ? "paused" : countsLine(workspace)}
                  </span>
                </button>
                <span className={FIGURE}>{formatCpu(workspace.cpu)}</span>
                <span className={FIGURE_STRONG}>
                  {formatMemory(workspace.memory)}
                </span>
                <span className="flex justify-end">
                  {!isActive && runState === "running" && (
                    <Button
                      variant="ghost"
                      size="xs"
                      title="Pause space: ends its shells, agents and pages until you open or resume it"
                      onClick={() => onPauseSpace(workspace.spaceId)}
                    >
                      <HugeiconsIcon
                        icon={PauseIcon}
                        size={12}
                        strokeWidth={2}
                      />
                      Pause
                    </Button>
                  )}
                  {!isActive && runState === "paused" && (
                    <Button
                      variant="ghost"
                      size="xs"
                      title="Resume space: starts its terminals and agents again"
                      onClick={() => onResumeSpace(workspace.spaceId)}
                    >
                      <HugeiconsIcon
                        icon={PlayIcon}
                        size={12}
                        strokeWidth={2}
                      />
                      Resume
                    </Button>
                  )}
                </span>
              </div>
              {!isCollapsed &&
                rows.map((row) => (
                  <UsageRowView key={row.key} row={row} onShow={onShowTab} />
                ))}
              {!isCollapsed && idleRows.length > 0 && (
                <div
                  className="truncate py-1 pl-9 pr-2 text-[11px] text-muted-foreground/60"
                  title={idleRows.map((row) => row.label).join(", ")}
                >
                  {idleRows.length} not running:{" "}
                  {idleRows.map((row) => row.label).join(", ")}
                </div>
              )}
            </section>
          );
        })}

        <section className="mt-2 border-t border-border/60 pt-2">
          <div className={cn(GRID, "px-2 py-1.5")}>
            <span className="flex min-w-0 items-center gap-2">
              <HugeiconsIcon
                icon={CpuIcon}
                size={14}
                strokeWidth={1.75}
                className="shrink-0 text-muted-foreground/70"
              />
              <span className={NAME}>Anbo itself</span>
              <span className={NOTE}>shared by every workspace</span>
            </span>
            <span className={FIGURE}>{formatCpu(model.anbo.cpu)}</span>
            <span className={FIGURE_STRONG}>
              {formatMemory(model.anbo.memory)}
            </span>
            <span />
          </div>
          {model.anbo.rows.map((row) => (
            <UsageRowView key={row.key} row={row} />
          ))}
        </section>
      </div>

      <p className="text-[11px] text-muted-foreground/70">
        Chrome and Edge tabs run in their own browser: its task manager
        (Shift+Esc there) shows what they use.
      </p>
    </>
  );
}

/** One of the two totals above the list, in the list's own columns. */
export function TotalRow({
  name,
  note,
  cpu,
  memory,
  of,
}: {
  name: string;
  note?: string;
  cpu: number | null;
  memory: number;
  /** What `memory` is a part of: the computer's installed memory. */
  of?: number;
}) {
  return (
    <div className={cn(GRID, "px-2 py-1")}>
      <span className="flex min-w-0 items-center gap-2">
        <span className={NAME}>{name}</span>
        {note && <span className={NOTE}>{note}</span>}
      </span>
      <span className={FIGURE}>{formatCpu(cpu)}</span>
      <span className={FIGURE_STRONG}>{formatMemory(memory)}</span>
      <span className={NOTE}>
        {of !== undefined && `of ${formatMemory(of)}`}
      </span>
    </div>
  );
}

function UsageRowView({
  row,
  onShow,
}: {
  row: UsageRow;
  onShow?: (tabId: number, leafId?: number) => void;
}) {
  const tabId = row.tabId;
  return (
    <div
      className={cn(
        GRID,
        "rounded-md py-1 pl-9 pr-2 hover:bg-accent/40",
        !row.running && "opacity-55",
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        <HugeiconsIcon
          icon={ROW_ICONS[row.kind]}
          size={13}
          strokeWidth={1.75}
          className="shrink-0 text-muted-foreground/70"
        />
        <span className="truncate text-[12px] text-foreground">
          {row.label}
        </span>
        {row.detail && <span className={NOTE}>{row.detail}</span>}
      </span>
      <span className={FIGURE}>{formatCpu(row.cpu)}</span>
      <span className={FIGURE}>{formatMemory(row.memory)}</span>
      <span className="flex justify-end">
        {onShow && tabId !== undefined && (
          <Button
            variant="ghost"
            size="xs"
            title={
              row.running ? "Show this tab" : "Show this tab: it starts again"
            }
            onClick={() =>
              onShow(tabId, row.kind === "agent" ? row.leafId : undefined)
            }
          >
            Show
          </Button>
        )}
      </span>
    </div>
  );
}
