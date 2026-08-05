import { AgentLauncherPanel } from "@/modules/agents/components/AgentLauncherPanel";
import type { AgentLaunchRequest } from "@/modules/agents/lib/launcher";
import {
  ComputerTerminal02Icon,
  GitBranchIcon,
  Globe02Icon,
  IncognitoIcon,
  PencilEdit02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { WorkspaceConstellation } from "./WorkspaceConstellation";

type WorkspaceWelcomeProps = {
  name: string | null;
  folder: string | null;
  onNew: () => void;
  onNewBlock: () => void;
  onNewPrivate: () => void;
  onNewPreview: () => void;
  onNewEditor: () => void;
  onNewGitGraph: () => void;
  onLaunchAgents: (request: AgentLaunchRequest) => void;
};

/**
 * A workspace is open but no tab is open yet. Offer the same actions as the
 * "new tab" menu (terminal / blocks / agents / privacy / editor / preview /
 * git graph) instead of auto-spawning a terminal on workspace creation.
 */
export function WorkspaceWelcome({
  name,
  folder,
  onNew,
  onNewBlock,
  onNewPrivate,
  onNewPreview,
  onNewEditor,
  onNewGitGraph,
  onLaunchAgents,
}: WorkspaceWelcomeProps) {
  const secondaryActions = [
    { label: "Blocks", icon: ComputerTerminal02Icon, onClick: onNewBlock },
    { label: "Privacy", icon: IncognitoIcon, onClick: onNewPrivate },
    { label: "Editor", icon: PencilEdit02Icon, onClick: onNewEditor },
    { label: "Preview", icon: Globe02Icon, onClick: onNewPreview },
    { label: "Git graph", icon: GitBranchIcon, onClick: onNewGitGraph },
  ];

  return (
    <div className="relative h-full w-full overflow-y-auto bg-background">
      <WorkspaceConstellation />
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(circle at 50% 28%, color-mix(in oklab, var(--background) 68%, transparent), var(--background) 62%)",
        }}
      />

      <div className="relative mx-auto flex min-h-full w-full max-w-xl flex-col justify-center px-5 py-10 sm:px-8">
        <header className="flex flex-col items-center text-center">
          <div className="flex items-center gap-2.5">
            <img src="/logo.svg" alt="" className="size-8" />
            <span className="font-mono text-2xl font-semibold tracking-[0.08em] text-foreground">
              anboai
            </span>
          </div>
          <h1 className="mt-4 font-heading text-xl font-medium tracking-tight text-foreground">
            Deploy your workspace
          </h1>
          <p className="mt-1.5 max-w-md text-sm text-muted-foreground">
            <span className="font-medium text-foreground">
              {name ?? "Workspace ready"}
            </span>{" "}
            is ready. Start a shell or assemble an agent layout.
          </p>
          {folder ? (
            <code
              className="mt-2 max-w-full truncate rounded-md border border-border/60 bg-background/60 px-2 py-1 font-mono text-[10px] text-muted-foreground"
              title={folder}
            >
              {folder}
            </code>
          ) : null}
        </header>

        <div className="mt-7 overflow-hidden rounded-3xl border border-border/70 bg-card/75 shadow-[0_24px_80px_-40px_color-mix(in_oklab,var(--foreground)_30%,transparent)] backdrop-blur-xl">
          <button
            type="button"
            onClick={onNew}
            className="group flex w-full items-center gap-3 border-b border-border/70 bg-primary/[0.045] px-5 py-4 text-left outline-none transition-colors hover:bg-primary/[0.08] focus-visible:bg-primary/[0.08]"
          >
            <span className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-primary/20 bg-background/70 text-foreground shadow-sm">
              <HugeiconsIcon
                icon={ComputerTerminal02Icon}
                size={17}
                strokeWidth={1.8}
              />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-foreground">
                Terminal
              </span>
              <span className="block text-[11px] text-muted-foreground">
                Open the default shell in this workspace
              </span>
            </span>
            <span className="font-mono text-[10px] text-muted-foreground transition-colors group-hover:text-foreground">
              shell
            </span>
          </button>

          <div className="p-4 sm:p-5">
            <AgentLauncherPanel variant="embedded" onLaunch={onLaunchAgents} />
          </div>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-1.5 sm:grid-cols-5">
          {secondaryActions.map((action) => (
            <button
              key={action.label}
              type="button"
              onClick={action.onClick}
              className="flex h-9 items-center justify-center gap-1.5 rounded-xl border border-border/60 bg-background/55 px-2 text-[11px] font-medium text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25"
            >
              <HugeiconsIcon icon={action.icon} size={13} strokeWidth={1.75} />
              {action.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
