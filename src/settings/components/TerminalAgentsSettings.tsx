import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { AgentIcon } from "@/modules/agents/lib/agentIcon";
import { isMcpAgentId } from "@/modules/agents/lib/agentMcp";
import {
  AGENT_LAUNCHERS,
  type AgentLaunchCommands,
  type CustomCliAgent,
  type CustomCliAgentIcon,
  DEFAULT_AGENT_LAUNCH_COMMANDS,
  newCustomCliAgentId,
  validateAgentLaunchCommand,
  validateCustomCliAgentName,
} from "@/modules/agents/lib/launcher";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  setAgentLaunchCommands,
  setAgentMcpEnabled,
  setCustomCliAgents,
} from "@/modules/settings/store";
import {
  Add01Icon,
  ArrowDown01Icon,
  Delete02Icon,
  Refresh01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";

const CUSTOM_AGENT_ICON_OPTIONS: {
  id: CustomCliAgentIcon;
  label: string;
}[] = [
  { id: "robot", label: "Robot" },
  ...AGENT_LAUNCHERS.map((agent) => ({
    id: agent.icon,
    label: agent.label,
  })),
];

export function TerminalAgentsSettings() {
  const commands = usePreferencesStore((state) => state.agentLaunchCommands);
  const mcpEnabled = usePreferencesStore((state) => state.agentMcpEnabled);
  const customAgents = usePreferencesStore((state) => state.customCliAgents);
  const [open, setOpen] = useState(true);
  const [newAgent, setNewAgent] = useState<CustomCliAgent | null>(null);
  const count = AGENT_LAUNCHERS.length + customAgents.length;

  const saveCustom = (agent: CustomCliAgent) => {
    void setCustomCliAgents([
      ...customAgents.filter((candidate) => candidate.id !== agent.id),
      agent,
    ]);
  };

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="mt-1 overflow-hidden rounded-lg border border-border/60 bg-card/40"
    >
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex w-full items-center justify-between gap-3 bg-muted/20 px-3 py-2.5 text-left transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30",
            open && "border-b border-border/60",
          )}
        >
          <div className="min-w-0">
            <div className="text-[12.5px] font-medium">AI agents CLI</div>
            <div className="text-[10.5px] text-muted-foreground">
              Commands shown in the New Tab launcher.
            </div>
          </div>
          <span className="flex shrink-0 items-center gap-2 text-[10.5px] text-muted-foreground">
            {count} agents
            <HugeiconsIcon
              icon={ArrowDown01Icon}
              size={13}
              strokeWidth={1.75}
              className={cn(
                "transition-transform duration-200",
                open && "rotate-180",
              )}
            />
          </span>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="anbo-collapsible-content">
        <div className="flex items-center justify-between gap-3 border-b border-border/60 px-3 py-2">
          <p className="text-[10.5px] leading-relaxed text-muted-foreground">
            Edit built-in commands or add a CLI agent.
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 shrink-0 gap-1.5 px-2 text-[11px]"
            disabled={newAgent !== null}
            onClick={() =>
              setNewAgent({
                id: newCustomCliAgentId(),
                icon: "robot",
                name: "",
                command: "",
              })
            }
          >
            <HugeiconsIcon icon={Add01Icon} size={12} strokeWidth={1.75} />
            New
          </Button>
        </div>
        <div className="flex flex-col gap-1.5 p-2">
          {AGENT_LAUNCHERS.map((agent) => (
            <BuiltInAgentRow
              key={agent.id}
              agent={agent}
              commands={commands}
              mcpEnabled={
                isMcpAgentId(agent.id) ? mcpEnabled[agent.id] : undefined
              }
              onMcpEnabledChange={
                isMcpAgentId(agent.id)
                  ? (enabled) =>
                      void setAgentMcpEnabled({
                        ...mcpEnabled,
                        [agent.id]: enabled,
                      })
                  : undefined
              }
            />
          ))}
          {customAgents.map((agent) => (
            <CustomCliAgentRow
              key={agent.id}
              agent={agent}
              existing={customAgents}
              onSave={saveCustom}
              onDelete={() =>
                void setCustomCliAgents(
                  customAgents.filter((candidate) => candidate.id !== agent.id),
                )
              }
            />
          ))}
          {newAgent ? (
            <CustomCliAgentRow
              agent={newAgent}
              existing={customAgents}
              isNew
              onSave={(agent) => {
                saveCustom(agent);
                setNewAgent(null);
              }}
              onDelete={() => setNewAgent(null)}
            />
          ) : null}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function BuiltInAgentRow({
  agent,
  commands,
  mcpEnabled,
  onMcpEnabledChange,
}: {
  agent: (typeof AGENT_LAUNCHERS)[number];
  commands: AgentLaunchCommands;
  mcpEnabled?: boolean;
  onMcpEnabledChange?: (enabled: boolean) => void;
}) {
  const [draft, setDraft] = useState(commands[agent.id]);
  const validation = validateAgentLaunchCommand(draft);

  useEffect(() => setDraft(commands[agent.id]), [agent.id, commands]);

  const save = (value: string) => {
    const result = validateAgentLaunchCommand(value);
    if (!result.ok) return;
    setDraft(result.command);
    if (result.command === commands[agent.id]) return;
    void setAgentLaunchCommands({ ...commands, [agent.id]: result.command });
  };
  const reset = () => {
    const command = DEFAULT_AGENT_LAUNCH_COMMANDS[agent.id];
    setDraft(command);
    void setAgentLaunchCommands({ ...commands, [agent.id]: command });
  };

  return (
    <div className="grid grid-cols-[16px_minmax(0,1fr)] items-center gap-x-2 gap-y-2 rounded-md border border-border/50 bg-background/35 px-2.5 py-2 sm:grid-cols-[16px_112px_minmax(0,1fr)_66px_32px]">
      <div className="flex size-4 items-center justify-center">
        <AgentIcon agent={agent.icon} size={14} className="shrink-0" />
      </div>
      <span className="truncate text-[11.5px] font-medium">{agent.label}</span>
      <Input
        value={draft}
        aria-label={`${agent.label} start command`}
        aria-invalid={!validation.ok}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => save(draft)}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") setDraft(commands[agent.id]);
        }}
        className="col-span-2 h-7 min-w-0 rounded-md bg-muted/25 px-2 font-mono text-[11px] sm:col-span-1"
        title={validation.ok ? undefined : validation.error}
      />
      <div
        className="col-span-1 hidden items-center justify-end gap-1.5 sm:flex"
        title={
          onMcpEnabledChange
            ? "Install Anbo MCP in this workspace when the agent launches"
            : "Automatic Anbo MCP setup is not available for this agent"
        }
      >
        <span className="text-[9.5px] text-muted-foreground">MCP</span>
        {onMcpEnabledChange ? (
          <Switch
            checked={mcpEnabled ?? false}
            onCheckedChange={onMcpEnabledChange}
            aria-label={`${agent.label} Anbo MCP`}
            className="scale-90"
          />
        ) : (
          <span className="w-7 text-center text-[10px] text-muted-foreground/50">
            -
          </span>
        )}
      </div>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="col-span-2 size-7 justify-self-end text-muted-foreground sm:col-span-1"
        disabled={draft === DEFAULT_AGENT_LAUNCH_COMMANDS[agent.id]}
        title={`Reset ${agent.label} command`}
        onClick={reset}
      >
        <HugeiconsIcon icon={Refresh01Icon} size={12} strokeWidth={1.75} />
      </Button>
    </div>
  );
}

function CustomCliAgentRow({
  agent,
  existing,
  isNew = false,
  onSave,
  onDelete,
}: {
  agent: CustomCliAgent;
  existing: readonly CustomCliAgent[];
  isNew?: boolean;
  onSave: (agent: CustomCliAgent) => void;
  onDelete: () => void;
}) {
  const [draft, setDraft] = useState(agent);
  useEffect(() => setDraft(agent), [agent]);

  const name = validateCustomCliAgentName(draft.name, existing, draft.id);
  const command = validateAgentLaunchCommand(draft.command);
  const changed =
    draft.icon !== agent.icon ||
    draft.name !== agent.name ||
    draft.command !== agent.command;
  const save = () => {
    if (!name.ok || !command.ok) return;
    onSave({
      id: draft.id,
      icon: draft.icon,
      name: name.name,
      command: command.command,
    });
  };

  return (
    <div className="grid grid-cols-[16px_minmax(0,1fr)] items-center gap-x-2 gap-y-2 rounded-md border border-border/50 bg-background/35 px-2.5 py-2 sm:grid-cols-[16px_134px_minmax(0,1fr)_56px]">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/30"
            title="Choose agent icon"
            aria-label="Choose agent icon"
          >
            <AgentIcon agent={draft.icon} size={14} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="w-44 min-w-44 rounded-xl p-1"
        >
          {CUSTOM_AGENT_ICON_OPTIONS.map((option) => (
            <DropdownMenuItem
              key={option.id}
              className="rounded-lg px-2 py-1.5 text-[11px]"
              onSelect={() =>
                setDraft((current) => ({
                  ...current,
                  icon: option.id,
                }))
              }
            >
              <AgentIcon agent={option.id} size={14} />
              <span className="flex-1">{option.label}</span>
              {draft.icon === option.id ? (
                <HugeiconsIcon icon={Tick02Icon} size={12} strokeWidth={2} />
              ) : null}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <Input
        value={draft.name}
        aria-label="Custom agent name"
        aria-invalid={!name.ok}
        placeholder="Agent name"
        autoFocus={isNew}
        onChange={(event) =>
          setDraft((current) => ({ ...current, name: event.target.value }))
        }
        className="h-7 min-w-0 rounded-md bg-muted/25 pr-2 pl-px text-[11.5px] font-medium md:text-[11.5px]"
        title={name.ok ? undefined : name.error}
      />
      <Input
        value={draft.command}
        aria-label="Custom agent start command"
        aria-invalid={!command.ok}
        placeholder="Start command"
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        onChange={(event) =>
          setDraft((current) => ({ ...current, command: event.target.value }))
        }
        onKeyDown={(event) => {
          if (event.key === "Enter") save();
          if (event.key === "Escape") {
            if (isNew) onDelete();
            else setDraft(agent);
          }
        }}
        className="col-span-2 h-7 min-w-0 rounded-md bg-muted/25 px-2 font-mono text-[11px] sm:col-span-1"
        title={command.ok ? undefined : command.error}
      />
      <div className="col-span-2 flex items-center justify-end gap-0.5 sm:col-span-1">
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-7 text-muted-foreground"
          disabled={!name.ok || !command.ok || (!isNew && !changed)}
          title={isNew ? "Add agent" : "Save agent"}
          onClick={save}
        >
          <HugeiconsIcon icon={Tick02Icon} size={12} strokeWidth={1.9} />
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-7 text-muted-foreground hover:text-destructive"
          title={isNew ? "Cancel" : "Delete agent"}
          onClick={onDelete}
        >
          <HugeiconsIcon icon={Delete02Icon} size={12} strokeWidth={1.75} />
        </Button>
      </div>
    </div>
  );
}
