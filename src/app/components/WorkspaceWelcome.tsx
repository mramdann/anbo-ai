import { Kbd } from "@/components/ui/kbd";
import { AgentLauncherPanel } from "@/modules/agents/components/AgentLauncherPanel";
import {
  type AgentLaunchRequest,
  getAgentLaunchers,
} from "@/modules/agents/lib/launcher";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { useShortcutLabel } from "@/modules/shortcuts";
import {
  ComputerTerminal02Icon,
  DashboardSquare01Icon,
  GitBranchIcon,
  Globe02Icon,
  IncognitoIcon,
  PencilEdit02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import type { CSSProperties } from "react";
import { WorkspaceConstellation } from "./WorkspaceConstellation";
import { daySeed, greetingFor, taglineFor } from "./workspaceWelcomeCopy";

type WorkspaceWelcomeProps = {
  name: string | null;
  folder: string | null;
  onNew: () => void;
  onNewBlock: () => void;
  onNewPrivate: () => void;
  onNewBrowser: () => void;
  onNewEditor: () => void;
  onNewGitGraph: () => void;
  onLaunchAgents: (request: AgentLaunchRequest) => void;
  /** Live repository facts for the header, when the folder is a checkout. */
  branch?: string | null;
  ahead?: number;
  behind?: number;
  changedCount?: number;
};

type TabAction = {
  id: string;
  icon: IconSvgElement;
  label: string;
  keys: string;
  run: () => void;
};

/** Staggered entrance: each block rises a beat after the one above it. */
function enter(delayMs: number): CSSProperties {
  return { animationDelay: `${delayMs}ms`, animationFillMode: "backwards" };
}

/**
 * A workspace is open but no tab is open yet.
 *
 * Anbo exists to run agents, so this is a launch deck rather than a menu: the
 * workspace's name and the live state of its repository at the top, the agents
 * installed on this machine as a roster of marks — pick one, set the command
 * and the count, launch — and the plainer tab types along the bottom edge with
 * the keys that open them. The launcher keeps its own state and logic; only
 * its shape is different here.
 */
export function WorkspaceWelcome({
  name,
  folder,
  onNew,
  onNewBlock,
  onNewPrivate,
  onNewBrowser,
  onNewEditor,
  onNewGitGraph,
  onLaunchAgents,
  branch = null,
  ahead = 0,
  behind = 0,
  changedCount = 0,
}: WorkspaceWelcomeProps) {
  // Real bindings, so a rebound key shows the key the user actually presses.
  const kTerminal = useShortcutLabel("tab.new");
  const kBlocks = useShortcutLabel("tab.newBlock");
  const kEditor = useShortcutLabel("tab.newEditor");
  const kBrowser = useShortcutLabel("tab.newBrowser");
  const kPrivate = useShortcutLabel("tab.newPrivate");
  const kPalette = useShortcutLabel("commandPalette.open");

  // The words. The greeting follows the clock; the line beneath the name is
  // chosen by workspace and day, so it holds still while you read it and is
  // different tomorrow, and it knows how many agents are on the bench.
  const customCliAgents = usePreferencesStore((s) => s.customCliAgents);
  const agentCount = getAgentLaunchers(customCliAgents).length;
  const now = new Date();
  const greeting = greetingFor(now.getHours());
  const tagline = taglineFor(daySeed(name, now), agentCount);

  const tabs: TabAction[] = [
    {
      id: "terminal",
      icon: ComputerTerminal02Icon,
      label: "Terminal",
      keys: kTerminal,
      run: onNew,
    },
    {
      id: "blocks",
      icon: DashboardSquare01Icon,
      label: "Blocks",
      keys: kBlocks,
      run: onNewBlock,
    },
    {
      id: "editor",
      icon: PencilEdit02Icon,
      label: "Editor",
      keys: kEditor,
      run: onNewEditor,
    },
    {
      id: "browser",
      icon: Globe02Icon,
      label: "Browser",
      keys: kBrowser,
      run: onNewBrowser,
    },
    {
      id: "private",
      icon: IncognitoIcon,
      label: "Private",
      keys: kPrivate,
      run: onNewPrivate,
    },
    {
      id: "git",
      icon: GitBranchIcon,
      label: "Git graph",
      keys: "",
      run: onNewGitGraph,
    },
  ];

  return (
    <div className="relative flex h-full w-full overflow-y-auto bg-background">
      <WorkspaceConstellation />
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(circle at 50% 36%, color-mix(in oklab, var(--background) 72%, transparent), transparent 68%)",
        }}
      />

      {/* Centred with auto margins rather than justify-center: when the window
          is shorter than this block, centring by justify-content pushes its top
          past the edge of the scroll box, out of reach of the scrollbar. */}
      <div className="@container relative m-auto w-full max-w-[46rem] px-6 py-12">
        <header className="anbo-pill-in text-center" style={enter(0)}>
          <div className="text-[10px] font-medium tracking-[0.28em] text-muted-foreground/60 uppercase">
            {greeting}
          </div>
          <h1 className="mt-2 truncate font-heading text-[34px] font-semibold tracking-[-0.02em] text-foreground">
            {name ?? "Untitled"}
          </h1>
          {/* Facts, not decoration: the path, and when it is a repository,
              the branch with how far it is from its upstream and how much is
              uncommitted. Each one is omitted rather than shown empty. */}
          <div className="mt-2 flex flex-wrap items-center justify-center gap-x-2.5 gap-y-1 font-mono text-[11px] text-muted-foreground/70">
            {folder ? (
              <span className="max-w-full truncate" title={folder}>
                {folder}
              </span>
            ) : null}
            {branch ? (
              <>
                <span aria-hidden="true" className="text-muted-foreground/40">
                  ·
                </span>
                <span className="inline-flex items-center gap-1">
                  <HugeiconsIcon
                    icon={GitBranchIcon}
                    size={11}
                    strokeWidth={1.75}
                  />
                  {branch}
                  {ahead > 0 ? (
                    <span className="text-muted-foreground/55">↑{ahead}</span>
                  ) : null}
                  {behind > 0 ? (
                    <span className="text-muted-foreground/55">↓{behind}</span>
                  ) : null}
                </span>
              </>
            ) : null}
            {changedCount > 0 ? (
              <>
                <span aria-hidden="true" className="text-muted-foreground/40">
                  ·
                </span>
                <span>{changedCount} changed</span>
              </>
            ) : null}
          </div>
          <p className="mx-auto mt-4 max-w-md font-heading text-[13.5px] leading-relaxed text-muted-foreground/85">
            {tagline}
          </p>
        </header>

        <section className="anbo-pill-in mt-9" style={enter(70)}>
          <Kicker>Launch an agent</Kicker>
          <div className="mt-4">
            <AgentLauncherPanel variant="deck" onLaunch={onLaunchAgents} />
          </div>
        </section>

        {/* Six actions on a grid of three, never a flowing row: a row wraps
            wherever it runs out of width, and six of these ran out one short,
            leaving the last alone on a line. Three by two is always whole. */}
        <div className="anbo-pill-in mt-8" style={enter(150)}>
          <Kicker>Or open a tab</Kicker>
          <nav
            aria-label="New tab"
            className="mt-3 grid grid-cols-2 justify-items-center gap-y-1 @[28rem]:grid-cols-3"
          >
            {tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={tab.run}
                className="group flex h-8 items-center gap-1.5 rounded-lg px-2 text-[12px] text-muted-foreground outline-none transition-colors hover:bg-foreground/[0.05] hover:text-foreground focus-visible:bg-foreground/[0.05] focus-visible:text-foreground"
              >
                <HugeiconsIcon
                  icon={tab.icon}
                  size={14}
                  strokeWidth={1.75}
                  className="opacity-70 transition-opacity group-hover:opacity-100"
                />
                {tab.label}
                {tab.keys ? (
                  <Kbd className="hidden h-4 min-w-0 rounded-md bg-muted/60 px-1 font-mono text-[9px] font-normal lowercase text-muted-foreground/70 @[40rem]:inline-flex">
                    {tab.keys}
                  </Kbd>
                ) : null}
              </button>
            ))}
          </nav>
          <p className="mt-6 text-center text-[11px] text-muted-foreground/55">
            Everything else is{" "}
            <Kbd className="h-4 min-w-0 rounded-md bg-muted/60 px-1 font-mono text-[9px] font-normal lowercase text-muted-foreground/75">
              {kPalette}
            </Kbd>{" "}
            away.
          </p>
        </div>
      </div>
    </div>
  );
}

/** A section label with a hairline either side: a beat between the parts. */
function Kicker({ children }: { children: string }) {
  return (
    <div className="flex items-center gap-3 text-[10px] font-medium tracking-[0.24em] text-muted-foreground/55 uppercase">
      <span className="h-px flex-1 bg-gradient-to-r from-transparent to-border/70" />
      <span className="shrink-0">{children}</span>
      <span className="h-px flex-1 bg-gradient-to-l from-transparent to-border/70" />
    </div>
  );
}
