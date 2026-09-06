import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { AgentIcon } from "@/modules/agents/lib/agentIcon";
import {
  AGENT_LAUNCHERS,
  type AgentInstanceCount,
  type AgentLaunchCommands,
  type AgentLauncherId,
  type AgentLaunchRequest,
  type BuiltInAgentLauncherId,
  DEFAULT_AGENT_LAUNCH_COMMANDS,
  findAgentLauncher,
  getAgentLaunchers,
  isBuiltInAgentLauncherId,
  validateAgentLaunchCommand,
} from "@/modules/agents/lib/launcher";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { setAgentLaunchCommands } from "@/modules/settings/store";
import {
  ArrowDown01Icon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
  PencilEdit02Icon,
  PlayIcon,
  Refresh01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useRef, useState } from "react";

type Props = {
  onBack?: () => void;
  onLaunch: (request: AgentLaunchRequest) => void;
  /**
   * "deck" is the empty-workspace arrangement: agents as a row of marks with
   * the launch controls on one line beneath. Same state, different shape.
   */
  variant?: "popover" | "embedded" | "deck";
};

const INSTANCE_COUNTS: AgentInstanceCount[] = [1, 2, 3, 4];
const TAB_LAYERS = [0, 1, 2, 3] as const;

export function AgentLauncherPanel({
  onBack,
  onLaunch,
  variant = "popover",
}: Props) {
  const storedCommands = usePreferencesStore((s) => s.agentLaunchCommands);
  const customCliAgents = usePreferencesStore((s) => s.customCliAgents);
  const hydrated = usePreferencesStore((s) => s.hydrated);
  const [agentId, setAgentId] = useState<AgentLauncherId>("claude");
  const [instances, setInstances] = useState<AgentInstanceCount>(1);
  const [drafts, setDrafts] = useState<AgentLaunchCommands>(storedCommands);
  const hydratedRef = useRef(hydrated);
  const persistedRef = useRef(storedCommands);
  const launchers = getAgentLaunchers(customCliAgents);
  const resolvedLauncher = findAgentLauncher(agentId, customCliAgents);
  const launcher = resolvedLauncher ?? AGENT_LAUNCHERS[0];
  const selectedId = launcher.id;
  const builtInSelected = isBuiltInAgentLauncherId(selectedId);
  const command = builtInSelected
    ? drafts[selectedId]
    : launcher.defaultCommand;
  const validation = validateAgentLaunchCommand(command);

  useEffect(() => {
    if (!hydrated || hydratedRef.current) return;
    hydratedRef.current = true;
    persistedRef.current = storedCommands;
    setDrafts(storedCommands);
  }, [hydrated, storedCommands]);

  useEffect(() => {
    if (!resolvedLauncher) setAgentId("claude");
  }, [resolvedLauncher]);

  // The deck roster is one row that scrolls sideways rather than wrapping
  // downward: the list of agents only grows, and a pane can be narrow. These
  // track whether anything is hidden past either edge, which is what decides
  // whether an arrow is drawn there.
  const rosterRef = useRef<HTMLDivElement>(null);
  const [hidden, setHidden] = useState({ left: false, right: false });
  // The deck shows the command as a line of text and only becomes a field when
  // asked: a box wide enough for a long command is mostly empty for "pi".
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    const roster = rosterRef.current;
    if (!roster) return;
    const measure = () => {
      setHidden({
        left: roster.scrollLeft > 1,
        right: roster.scrollLeft + roster.clientWidth < roster.scrollWidth - 1,
      });
    };
    measure();
    roster.addEventListener("scroll", measure, { passive: true });
    // The box and the track inside it: the box changes with the pane, the
    // track with the number of agents, and either can put something out of
    // view or bring it back.
    const observer = new ResizeObserver(measure);
    observer.observe(roster);
    if (roster.firstElementChild) observer.observe(roster.firstElementChild);
    // A vertical wheel over the roster moves it sideways, since sideways is
    // the only way it goes. Only while there is somewhere to go, so the page
    // keeps its own scrolling when everything already fits.
    const onWheel = (event: WheelEvent) => {
      if (roster.scrollWidth <= roster.clientWidth) return;
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      event.preventDefault();
      roster.scrollLeft += event.deltaY;
    };
    roster.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      roster.removeEventListener("scroll", measure);
      roster.removeEventListener("wheel", onWheel);
      observer.disconnect();
    };
  }, []);

  // Keep the chosen agent in view, including on first paint when it may sit
  // past the edge.
  useEffect(() => {
    const roster = rosterRef.current;
    if (!roster) return;
    const chosen = roster.querySelector<HTMLElement>(
      `[data-agent-id="${CSS.escape(selectedId)}"]`,
    );
    chosen?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [selectedId]);

  const scrollRoster = (direction: -1 | 1) => {
    const roster = rosterRef.current;
    if (!roster) return;
    roster.scrollBy({
      left: direction * Math.max(160, roster.clientWidth * 0.6),
      behavior: "smooth",
    });
  };

  const save = (next: AgentLaunchCommands) => {
    const changed = AGENT_LAUNCHERS.some(
      ({ id }) => next[id] !== persistedRef.current[id],
    );
    if (!changed) return;
    const previous = persistedRef.current;
    persistedRef.current = next;
    void setAgentLaunchCommands(next).catch((error) => {
      persistedRef.current = previous;
      console.error("[anbo] failed to save agent launch commands:", error);
    });
  };

  const persist = (
    id: BuiltInAgentLauncherId,
    value: string,
  ): AgentLaunchCommands | null => {
    const result = validateAgentLaunchCommand(value);
    if (!result.ok) return null;
    const next = { ...drafts, [id]: result.command };
    setDrafts(next);
    save(next);
    return next;
  };

  const selectAgent = (id: AgentLauncherId) => {
    if (isBuiltInAgentLauncherId(selectedId)) persist(selectedId, command);
    setAgentId(id);
    setEditing(false);
  };

  const resetCommand = () => {
    if (!isBuiltInAgentLauncherId(selectedId)) return;
    const next = {
      ...drafts,
      [selectedId]: DEFAULT_AGENT_LAUNCH_COMMANDS[selectedId],
    };
    setDrafts(next);
    save(next);
  };

  const submit = () => {
    const result = validateAgentLaunchCommand(command);
    if (!result.ok) return;
    if (isBuiltInAgentLauncherId(selectedId)) {
      const next = persist(selectedId, result.command);
      if (!next) return;
    }
    onLaunch({
      agent: selectedId,
      command: result.command,
      instances,
    });
  };

  if (variant === "deck") {
    return (
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {/* The roster. Marks rather than labelled rows: at this size the
            brand is the label, and the selected one lifts and lights. One
            row, scrolled sideways when it overflows. The inner track carries
            auto margins so it sits centred while it fits and simply scrolls
            once it does not — centring the scroll box itself would push the
            first agents past the left edge where no scrolling reaches them. */}
        <div className="relative">
          {hidden.left ? (
            <RosterEdge side="left" onClick={() => scrollRoster(-1)} />
          ) : null}
          {hidden.right ? (
            <RosterEdge side="right" onClick={() => scrollRoster(1)} />
          ) : null}
          <div
            ref={rosterRef}
            className="flex overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            <div className="mx-auto flex gap-x-1.5 px-1 py-1">
              {launchers.map((agent) => {
                const selected = agent.id === selectedId;
                return (
                  <button
                    key={agent.id}
                    type="button"
                    disabled={!hydrated}
                    aria-pressed={selected}
                    data-agent-id={agent.id}
                    onClick={() => selectAgent(agent.id)}
                    className={cn(
                      "group flex min-w-[4.75rem] max-w-[6.5rem] shrink-0 flex-col items-center gap-1.5 rounded-xl px-1.5 pt-1.5 pb-1 outline-none transition-opacity duration-200 focus-visible:ring-2 focus-visible:ring-ring/25 disabled:pointer-events-none disabled:opacity-50",
                      selected ? "" : "opacity-65 hover:opacity-100",
                    )}
                  >
                    <span
                      className={cn(
                        "flex size-12 items-center justify-center rounded-2xl border transition-[border-color,box-shadow,transform,background-color] duration-200",
                        selected
                          ? "-translate-y-0.5 border-primary/60 bg-background shadow-[0_0_0_4px_color-mix(in_oklab,var(--primary)_18%,transparent),0_14px_32px_-16px_color-mix(in_oklab,var(--primary)_65%,transparent)]"
                          : "border-border/60 bg-background/70 group-hover:-translate-y-0.5 group-hover:border-border",
                      )}
                    >
                      <AgentIcon agent={agent.icon} size={22} tone="brand" />
                    </span>
                    <span
                      className={cn(
                        "max-w-full truncate text-[11px] font-medium",
                        selected ? "text-foreground" : "text-muted-foreground",
                      )}
                    >
                      {agent.label}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* No box. The command is a quiet line beneath the roster and the
            action is one button, large and centred, that names the agent it
            will launch. The count rides on the end of the button as a menu
            rather than sitting beside it as a control: it is a detail of the
            launch, not a peer of it. Nothing here needs a second layout for a
            narrow pane — a centred column simply gets narrower. */}
        <div className="mt-5 flex flex-col items-center gap-4">
          <div className="flex max-w-full min-w-0 items-baseline gap-2 px-2 font-mono text-[13px]">
            <span aria-hidden="true" className="shrink-0 text-primary">
              $
            </span>
            {editing ? (
              <Input
                id="agent-start-command"
                aria-label="Start command"
                autoFocus
                disabled={!hydrated}
                value={command}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                aria-invalid={!validation.ok}
                onChange={(event) => {
                  setDrafts((current) => ({
                    ...current,
                    [selectedId]: event.target.value,
                  }));
                }}
                onBlur={() => {
                  if (builtInSelected) persist(selectedId, command);
                  if (validation.ok) setEditing(false);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    // Commit the line, not the form: launching is what the
                    // button is for.
                    event.preventDefault();
                    event.currentTarget.blur();
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    if (isBuiltInAgentLauncherId(selectedId)) {
                      const id = selectedId;
                      setDrafts((current) => ({
                        ...current,
                        [id]: persistedRef.current[id],
                      }));
                    }
                    setEditing(false);
                  }
                }}
                className="h-6 w-[24rem] max-w-full min-w-0 rounded-none border-0 border-b border-primary/50 bg-transparent px-0 text-center font-mono text-[13px] shadow-none focus-visible:border-primary focus-visible:ring-0"
              />
            ) : (
              <button
                type="button"
                disabled={!hydrated || !builtInSelected}
                onClick={() => setEditing(true)}
                title={builtInSelected ? "Edit start command" : undefined}
                className="group flex min-w-0 items-baseline gap-2 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/25 disabled:cursor-default"
              >
                <span className="truncate text-foreground/90">{command}</span>
                {builtInSelected ? (
                  <HugeiconsIcon
                    icon={PencilEdit02Icon}
                    size={12}
                    strokeWidth={1.75}
                    className="shrink-0 translate-y-px text-muted-foreground opacity-0 transition-opacity group-hover:opacity-70 group-focus-visible:opacity-70"
                  />
                ) : null}
              </button>
            )}
            {builtInSelected &&
            command !== DEFAULT_AGENT_LAUNCH_COMMANDS[selectedId] ? (
              <button
                type="button"
                onClick={resetCommand}
                disabled={!hydrated}
                className="inline-flex shrink-0 items-center gap-1 rounded-sm text-[11px] text-muted-foreground/70 transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/25"
                title={`Reset to ${launcher.defaultCommand}`}
                aria-label={`Reset to ${launcher.defaultCommand}`}
              >
                <HugeiconsIcon
                  icon={Refresh01Icon}
                  size={11}
                  strokeWidth={1.75}
                />
              </button>
            ) : null}
          </div>
          {validation.ok ? null : (
            <div className="-mt-2 text-[11px] text-destructive">
              {validation.error}
            </div>
          )}

          <div className="flex items-stretch">
            <Button
              type="submit"
              size="lg"
              className="h-10 rounded-xl rounded-r-none px-5 text-[13px]"
              disabled={!hydrated || !validation.ok}
            >
              <HugeiconsIcon icon={PlayIcon} size={14} strokeWidth={2} />
              Launch {launcher.label}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  size="lg"
                  disabled={!hydrated}
                  aria-label={`${instances} ${instances === 1 ? "instance" : "instances"}, change`}
                  className="h-10 gap-1 rounded-xl rounded-l-none border-l border-primary-foreground/20 px-3 font-mono text-[12px]"
                >
                  ×{instances}
                  <HugeiconsIcon
                    icon={ArrowDown01Icon}
                    size={12}
                    strokeWidth={2}
                    className="opacity-70"
                  />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[10rem]">
                <DropdownMenuRadioGroup
                  value={String(instances)}
                  onValueChange={(value) => {
                    const next = INSTANCE_COUNTS.find(
                      (count) => String(count) === value,
                    );
                    if (next) setInstances(next);
                  }}
                >
                  {INSTANCE_COUNTS.map((count) => (
                    <DropdownMenuRadioItem key={count} value={String(count)}>
                      {count} {count === 1 ? "instance" : "instances"}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </form>
    );
  }

  return (
    <form
      className={cn(
        variant === "popover" &&
          "animate-in fade-in-0 slide-in-from-right-2 duration-150",
      )}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="flex h-9 items-center gap-2 px-1">
        {onBack ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="rounded-md text-muted-foreground"
            onClick={onBack}
            aria-label="Back to new tab menu"
          >
            <HugeiconsIcon
              icon={ArrowLeft01Icon}
              size={14}
              strokeWidth={1.75}
            />
          </Button>
        ) : null}
        <div className="min-w-0">
          <div className="text-[13px] font-medium text-foreground">
            {variant === "embedded" ? "Agents" : "Launch agents"}
          </div>
          <div className="text-[10px] text-muted-foreground">
            Up to four independent tabs
          </div>
        </div>
      </div>

      <div className="mt-1 grid max-h-44 grid-cols-2 gap-1 overflow-y-auto border-t border-border/60 pt-1.5 pr-0.5">
        {launchers.map((agent) => {
          const selected = agent.id === selectedId;
          return (
            <button
              key={agent.id}
              type="button"
              disabled={!hydrated}
              aria-pressed={selected}
              onClick={() => selectAgent(agent.id)}
              className={cn(
                "flex min-w-0 items-center gap-2 rounded-xl border px-2.5 py-2 text-left transition-colors outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25 disabled:pointer-events-none disabled:opacity-50",
                selected
                  ? "border-primary/35 bg-primary/10 text-foreground"
                  : "border-transparent bg-foreground/[0.035] text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              <AgentIcon
                agent={agent.icon}
                size={16}
                className={cn(
                  "shrink-0",
                  selected ? "text-primary" : "text-muted-foreground",
                )}
              />
              <span className="truncate text-xs font-medium">
                {agent.label}
              </span>
            </button>
          );
        })}
      </div>

      <fieldset className="mt-3">
        <legend className="mb-1.5 text-[11px] font-medium text-muted-foreground">
          Instances
        </legend>
        <div className="grid grid-cols-4 gap-1">
          {INSTANCE_COUNTS.map((count) => (
            <button
              key={count}
              type="button"
              disabled={!hydrated}
              aria-label={`${count} ${count === 1 ? "instance" : "instances"}`}
              aria-pressed={instances === count}
              onClick={() => setInstances(count)}
              className={cn(
                "flex h-9 items-center justify-center gap-1.5 rounded-xl border text-xs font-medium transition-colors outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25 disabled:pointer-events-none disabled:opacity-50",
                instances === count
                  ? "border-primary/35 bg-primary/10 text-foreground"
                  : "border-border/60 bg-background/30 text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              <TabCountGlyph count={count} />
              {count}
            </button>
          ))}
        </div>
      </fieldset>

      <div className="mt-3">
        <div className="mb-1.5 flex items-center">
          <label
            htmlFor="agent-start-command"
            className="text-[11px] font-medium text-muted-foreground"
          >
            Start command
          </label>
          {builtInSelected ? (
            <button
              type="button"
              onClick={resetCommand}
              disabled={
                !hydrated ||
                command === DEFAULT_AGENT_LAUNCH_COMMANDS[selectedId]
              }
              className="ml-auto flex items-center gap-1 rounded-md px-1 text-[10px] text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
              title={`Reset to ${launcher.defaultCommand}`}
            >
              <HugeiconsIcon
                icon={Refresh01Icon}
                size={11}
                strokeWidth={1.75}
              />
              Reset
            </button>
          ) : (
            <span className="ml-auto text-[10px] text-muted-foreground">
              Custom CLI
            </span>
          )}
        </div>
        <Input
          id="agent-start-command"
          disabled={!hydrated}
          value={command}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          readOnly={!builtInSelected}
          aria-invalid={!validation.ok}
          onChange={(event) => {
            if (!builtInSelected) return;
            setDrafts((current) => ({
              ...current,
              [selectedId]: event.target.value,
            }));
          }}
          onBlur={() => {
            if (builtInSelected) persist(selectedId, command);
          }}
          className="h-8 rounded-xl bg-input/40 px-2.5 font-mono text-xs"
          placeholder={launcher.defaultCommand}
        />
        <div
          className={cn(
            "mt-1 min-h-4 text-[10px]",
            validation.ok ? "text-muted-foreground" : "text-destructive",
          )}
        >
          {validation.ok
            ? builtInSelected
              ? "Aliases and flags are supported."
              : "Edit this command in General settings."
            : validation.error}
        </div>
      </div>

      <Button
        type="submit"
        size="sm"
        className="mt-1 w-full rounded-xl"
        disabled={!hydrated || !validation.ok}
      >
        <HugeiconsIcon icon={PlayIcon} size={13} strokeWidth={2} />
        Launch {instances} {instances === 1 ? "agent" : "agents"}
      </Button>
    </form>
  );
}

/**
 * The edge of an overflowing roster: a fade that says there is more, and an
 * arrow that goes there. Drawn only on the side that actually has more.
 */
function RosterEdge({
  side,
  onClick,
}: {
  side: "left" | "right";
  onClick: () => void;
}) {
  const left = side === "left";
  return (
    <div
      className={cn(
        "pointer-events-none absolute inset-y-0 z-10 flex w-14 items-center",
        left
          ? "left-0 justify-start bg-gradient-to-r from-background via-background/80 to-transparent"
          : "right-0 justify-end bg-gradient-to-l from-background via-background/80 to-transparent",
      )}
    >
      <button
        type="button"
        onClick={onClick}
        aria-label={left ? "Earlier agents" : "More agents"}
        className="pointer-events-auto flex size-7 items-center justify-center rounded-full border border-border/60 bg-background/90 text-muted-foreground shadow-sm transition-colors hover:border-border hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/25 outline-none"
      >
        <HugeiconsIcon
          icon={left ? ArrowLeft01Icon : ArrowRight01Icon}
          size={14}
          strokeWidth={1.75}
        />
      </button>
    </div>
  );
}

function TabCountGlyph({ count }: { count: AgentInstanceCount }) {
  return (
    <span className="relative block h-3 w-3.5" aria-hidden="true">
      {TAB_LAYERS.slice(0, count).map((layer) => (
        <span
          key={`tab-layer-${layer}`}
          className="absolute h-2.5 w-2 rounded-[2px] border border-current/60 bg-background"
          style={{ left: layer, top: count - layer - 1 }}
        />
      ))}
    </span>
  );
}
