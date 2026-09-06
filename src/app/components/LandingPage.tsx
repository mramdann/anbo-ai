import { Button } from "@/components/ui/button";
import { WindowControls } from "@/components/WindowControls";
import { AgentIcon } from "@/modules/agents/lib/agentIcon";
import { getAgentLaunchers } from "@/modules/agents/lib/launcher";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { Folder01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { open } from "@tauri-apps/plugin-dialog";
import { type CSSProperties, useState } from "react";
import { WorkspaceConstellation } from "./WorkspaceConstellation";
import { benchCaption } from "./workspaceWelcomeCopy";

type LandingPageProps = {
  onPick: (dir: string, name: string) => void;
  onUseHome: () => void;
  home: string | null;
  /**
   * Given for a workspace that exists but has no folder yet. Left out on the
   * very first run, where the page introduces Anbo instead.
   */
  title?: string;
  description?: string;
  /** Render min/max/close controls — use when no Header is present (e.g. the
   * first-run landing). */
  showWindowControls?: boolean;
};

/** Marks shown on the first run: enough to say what Anbo is for, no more. */
const VISIBLE_MARKS = 6;

/** Staggered entrance: each block rises a beat after the one above it. */
function enter(delayMs: number): CSSProperties {
  return { animationDelay: `${delayMs}ms`, animationFillMode: "backwards" };
}

/**
 * No workspace yet. Pick a folder, and optionally name it.
 *
 * On the first run this is the front door, so it says what the place is for
 * before asking for anything: a line about the bench, the agents already on
 * it, and one button. For a workspace that merely lacks a folder, the same
 * shape carries that workspace's name and a plainer sentence.
 */
export function LandingPage({
  onPick,
  onUseHome,
  home,
  title,
  description,
  showWindowControls = false,
}: LandingPageProps) {
  const firstRun = title === undefined;
  const [name, setName] = useState("");
  const customCliAgents = usePreferencesStore((s) => s.customCliAgents);
  const agents = getAgentLaunchers(customCliAgents);

  const chooseFolder = async () => {
    const selected = await open({ directory: true, multiple: false });
    if (!selected) return; // user cancelled
    const dir = selected.replace(/\\/g, "/");
    // Default the workspace name to the folder basename when left empty.
    const resolved =
      name.trim() || dir.replace(/\/+$/, "").split("/").pop() || "workspace";
    onPick(dir, resolved);
  };

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
      {showWindowControls ? (
        <div
          data-tauri-drag-region
          className="zoom-exempt absolute inset-x-0 top-0 z-30 flex h-9 items-stretch justify-end"
        >
          <WindowControls />
        </div>
      ) : null}

      {/* Centred with auto margins rather than justify-center: when the window
          is shorter than this block, centring by justify-content pushes its top
          past the edge of the scroll box, out of reach of the scrollbar. */}
      <div className="relative m-auto w-full max-w-[34rem] px-6 py-14 text-center">
        <header className="anbo-pill-in" style={enter(0)}>
          {/* On the first run the mark is the brand and stands at full
              strength; for a workspace without a folder it is only a label,
              and steps back the way the kicker on the launch deck does. */}
          {firstRun ? (
            <div className="flex items-center justify-center gap-2.5 text-[12px] font-semibold tracking-[0.3em] text-foreground uppercase">
              <img src="/logo.svg" alt="" className="size-5" />
              anbo
            </div>
          ) : (
            <div className="text-[10px] font-medium tracking-[0.28em] text-muted-foreground/60 uppercase">
              Workspace
            </div>
          )}
          <h1 className="mt-3 font-heading text-[30px] leading-tight font-semibold tracking-[-0.02em] text-foreground">
            {firstRun ? "One bench for every agent you run." : title}
          </h1>
          <p className="mx-auto mt-3 max-w-md text-[13.5px] leading-relaxed text-muted-foreground/85">
            {firstRun
              ? "Point Anbo at a folder. Terminals, browsers and agents open there, side by side."
              : (description ??
                "Choose a folder for this workspace before opening tabs.")}
          </p>
        </header>

        <form
          className="anbo-pill-in mt-9 flex flex-col items-center gap-4"
          style={enter(70)}
          onSubmit={(event) => {
            event.preventDefault();
            void chooseFolder();
          }}
        >
          {/* A name is optional and says so; it does not get a box, only a
              line to write on. The folder's own name is the default. */}
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Name it — optional"
            aria-label="Workspace name"
            spellCheck={false}
            className="w-64 max-w-full border-b border-border/60 bg-transparent pb-1.5 text-center font-mono text-[13px] text-foreground transition-colors outline-none placeholder:text-muted-foreground/50 focus:border-primary/60"
          />
          <Button
            type="submit"
            size="sm"
            className="h-10 rounded-xl px-5 text-[13px]"
          >
            <HugeiconsIcon icon={Folder01Icon} size={16} strokeWidth={1.8} />
            Choose a folder
          </Button>
          {home ? (
            <button
              type="button"
              onClick={onUseHome}
              className="rounded-sm text-[12px] text-muted-foreground/75 transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/25"
            >
              or start in your home folder
            </button>
          ) : null}
        </form>

        {firstRun && agents.length > 0 ? (
          <div className="anbo-pill-in mt-12" style={enter(150)}>
            {/* The agents on the bench, wearing their own marks: the quickest
                way to say what this is for, before a single folder is open. */}
            <div className="flex flex-wrap justify-center gap-1.5">
              {agents.slice(0, VISIBLE_MARKS).map((agent) => (
                <span
                  key={agent.id}
                  title={agent.label}
                  className="flex size-9 items-center justify-center rounded-xl border border-border/50 bg-background/70"
                >
                  <AgentIcon agent={agent.icon} size={15} tone="brand" />
                </span>
              ))}
            </div>
            <p className="mt-3 text-[11px] text-muted-foreground/60">
              {benchCaption(agents.map((agent) => agent.label))}
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
