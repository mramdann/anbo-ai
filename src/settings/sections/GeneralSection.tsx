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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { AgentIcon } from "@/modules/agents/lib/agentIcon";
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
import type { ThemePref } from "@/modules/settings/store";
import {
  setAgentLaunchCommands,
  setAgentNotifications,
  setAutostart,
  setCustomCliAgents,
  setDefaultWorkspaceEnv,
  setExplorerGitDecorations,
  setRestoreWindowState,
  setShowHidden,
  setTerminalCursorBlink,
  setTerminalCursorStyle,
  setTerminalFontFamily,
  setTerminalFontSize,
  setTerminalFontWeight,
  setTerminalLetterSpacing,
  setTerminalScrollback,
  setTerminalShell,
  setTerminalWebglEnabled,
  setZoomLevel,
  TERMINAL_FONT_SIZES,
  TERMINAL_SCROLLBACK_PRESETS,
} from "@/modules/settings/store";
import { useTheme } from "@/modules/theme";
import {
  Add01Icon,
  ArrowDown01Icon,
  ComputerIcon,
  Delete02Icon,
  Moon02Icon,
  Refresh01Icon,
  Sun03Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { invoke } from "@tauri-apps/api/core";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import { useEffect, useState } from "react";
import { SectionHeader } from "../components/SectionHeader";
import { SettingRow } from "../components/SettingRow";

const APPEARANCE: {
  id: ThemePref;
  label: string;
  icon: typeof ComputerIcon;
}[] = [
  { id: "system", label: "System", icon: ComputerIcon },
  { id: "light", label: "Light", icon: Sun03Icon },
  { id: "dark", label: "Dark", icon: Moon02Icon },
];

const TERMINAL_FONT_WEIGHTS = [
  { value: "normal", label: "Normal" },
  { value: "500", label: "Medium" },
  { value: "600", label: "Semi-Bold" },
  { value: "bold", label: "Bold" },
] as const;
const TERMINAL_CURSOR_STYLES = [
  { value: "bar", label: "Bar" },
  { value: "block", label: "Block" },
  { value: "underline", label: "Underline" },
] as const;
const LETTER_SPACINGS = [-4, -3, -2, -1, 0, 1, 2, 3, 4] as const;
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

type ShellInfo = { name: string; path: string; integrated: boolean };
const SHELL_AUTO = "auto";
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.0;
const ZOOM_STEP = 0.05;

export function GeneralSection() {
  const { mode, setMode } = useTheme();

  const autostart = usePreferencesStore((s) => s.autostart);
  const restoreWindowState = usePreferencesStore((s) => s.restoreWindowState);
  const showHidden = usePreferencesStore((s) => s.showHidden);
  const explorerGitDecorations = usePreferencesStore(
    (s) => s.explorerGitDecorations,
  );
  const terminalWebglEnabled = usePreferencesStore(
    (s) => s.terminalWebglEnabled,
  );
  const terminalCursorBlink = usePreferencesStore((s) => s.terminalCursorBlink);
  const terminalCursorStyle = usePreferencesStore((s) => s.terminalCursorStyle);
  const terminalFontFamily = usePreferencesStore((s) => s.terminalFontFamily);
  const terminalFontWeight = usePreferencesStore((s) => s.terminalFontWeight);
  const terminalShell = usePreferencesStore((s) => s.terminalShell);
  const [shells, setShells] = useState<ShellInfo[]>([]);
  const [wslDistros, setWslDistros] = useState<{ name: string }[]>([]);
  const defaultWorkspaceEnv = usePreferencesStore((s) => s.defaultWorkspaceEnv);
  const terminalLetterSpacing = usePreferencesStore(
    (s) => s.terminalLetterSpacing,
  );
  const terminalFontSize = usePreferencesStore((s) => s.terminalFontSize);
  const terminalScrollback = usePreferencesStore((s) => s.terminalScrollback);
  const zoomLevel = usePreferencesStore((s) => s.zoomLevel);
  const agentNotifications = usePreferencesStore((s) => s.agentNotifications);

  useEffect(() => {
    let alive = true;
    void isEnabled()
      .then((on) => {
        if (!alive) return;
        if (on !== usePreferencesStore.getState().autostart) {
          void setAutostart(on);
        }
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    void invoke<ShellInfo[]>("pty_list_shells")
      .then(setShells)
      .catch(() => {});
    void invoke<{ name: string }[]>("wsl_list_distros")
      .then(setWslDistros)
      .catch(() => {});
  }, []);

  const onToggleAutostart = async (next: boolean) => {
    try {
      if (next) await enable();
      else await disable();
      await setAutostart(next);
    } catch (e) {
      console.error("autostart toggle failed", e);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader
        title="General"
        description="Mode, terminal, and startup."
      />

      <div className="flex flex-col gap-2">
        <Label>Appearance</Label>
        <div className="grid grid-cols-3 gap-2">
          {APPEARANCE.map((o) => (
            <button
              key={o.id}
              type="button"
              onClick={() => setMode(o.id)}
              className={cn(
                "group flex h-20 flex-col items-center justify-center gap-1.5 rounded-lg border bg-card transition-all",
                mode === o.id
                  ? "border-foreground/60 ring-1 ring-foreground/20"
                  : "border-border/60 hover:border-border",
              )}
            >
              <HugeiconsIcon icon={o.icon} size={18} strokeWidth={1.5} />
              <span className="text-[11.5px]">{o.label}</span>
            </button>
          ))}
        </div>
        <p className="text-[11px] text-muted-foreground">
          For theme, background and customization, see the{" "}
          <strong className="font-medium text-foreground">Themes</strong> tab.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <Label>Zoom</Label>
        <div className="flex flex-col gap-3 rounded-lg border border-border/60 p-3">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[11.5px] text-muted-foreground">
              UI zoom level
            </span>
            <span className="tabular-nums text-[11px] text-muted-foreground">
              {Math.round(zoomLevel * 100)}%
            </span>
          </div>
          <Slider
            value={[zoomLevel]}
            min={ZOOM_MIN}
            max={ZOOM_MAX}
            step={ZOOM_STEP}
            onValueChange={(v) => void setZoomLevel(v[0] ?? 1)}
          />
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <Label>Explorer</Label>
        <SettingRow
          title="Show hidden files"
          description="Include dot-prefixed files and folders (.env, .gitignore, .config) in the file explorer and search."
        >
          <Switch
            checked={showHidden}
            onCheckedChange={(v) => void setShowHidden(v)}
          />
        </SettingRow>
        <SettingRow
          title="Git decorations"
          description="Tint changed files and dim gitignored entries in the file explorer."
        >
          <Switch
            checked={explorerGitDecorations}
            onCheckedChange={(v) => void setExplorerGitDecorations(v)}
          />
        </SettingRow>
      </div>

      <div className="flex flex-col gap-2">
        <Label>Terminal</Label>
        <SettingRow
          title={
            <span className="inline-flex items-center gap-1.5">
              Use WebGL renderer
              <TooltipProvider delayDuration={200}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span
                      className="cursor-help text-[11px] text-muted-foreground/70 leading-none"
                      aria-label="More info about WebGL renderer"
                    >
                      ⓘ
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="max-w-65 text-[11px]">
                    xterm's WebGL renderer caches glyphs in a GPU texture atlas.
                    On some macOS setups (especially with Nerd Fonts), the atlas
                    corrupts and terminal text becomes unreadable. Turn this off
                    as a fallback — performance dips slightly, but text renders
                    correctly via the DOM renderer.
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </span>
          }
          description="Hardware-accelerated rendering. Turn off if text shows corruption or blank tiles."
        >
          <Switch
            checked={terminalWebglEnabled}
            onCheckedChange={(v) => void setTerminalWebglEnabled(v)}
          />
        </SettingRow>
        <SettingRow
          title="Cursor blinking"
          description="Blink the terminal cursor. Off by default for lower idle CPU, matching VS Code and the macOS terminal."
        >
          <Switch
            checked={terminalCursorBlink}
            onCheckedChange={(v) => void setTerminalCursorBlink(v)}
          />
        </SettingRow>
        <SettingRow
          title="Cursor style"
          description="Shape of the terminal cursor."
        >
          <Select
            value={terminalCursorStyle}
            onValueChange={(v) => void setTerminalCursorStyle(v)}
          >
            <SelectTrigger
              value={terminalCursorStyle}
              className="h-8 w-28 text-[12px]"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TERMINAL_CURSOR_STYLES.map((style) => (
                <SelectItem
                  key={style.value}
                  value={style.value}
                  className="text-[12px]"
                >
                  {style.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
        <FontFamilyInput
          value={terminalFontFamily}
          onCommit={(v) => void setTerminalFontFamily(v)}
        />
        <SettingRow
          title="Font weight"
          description="Thickness of terminal characters"
        >
          <Select
            value={terminalFontWeight}
            onValueChange={(v) => void setTerminalFontWeight(v)}
          >
            <SelectTrigger
              value={terminalFontWeight}
              className="h-8 w-28 text-[12px]"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TERMINAL_FONT_WEIGHTS.map((w) => (
                <SelectItem
                  key={w.value}
                  value={w.value}
                  className="text-[12px]"
                >
                  {w.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow
          title="Integrated terminal shell"
          description={
            shells.find((s) => s.path === terminalShell)?.integrated === false
              ? "Command blocks and directory tracking are unavailable for this shell."
              : wslDistros.length > 0
                ? "Shell for the integrated terminal. WSL spaces use the distro login shell. Existing tabs keep their shell."
                : "Shell for new terminal tabs. Existing tabs keep their shell."
          }
        >
          <Select
            value={terminalShell || SHELL_AUTO}
            onValueChange={(v) =>
              void setTerminalShell(v === SHELL_AUTO ? "" : v)
            }
          >
            <SelectTrigger
              value={terminalShell || SHELL_AUTO}
              className="h-8 w-40 text-[12px]"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={SHELL_AUTO} className="text-[12px]">
                Auto
              </SelectItem>
              {shells.map((s) => (
                <SelectItem key={s.path} value={s.path} className="text-[12px]">
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
        {(wslDistros.length > 0 || defaultWorkspaceEnv !== "local") && (
          <SettingRow
            title="Workspace environment"
            description="Where new spaces run, terminal and AI agent alike: Windows or a WSL distro. Existing spaces keep theirs; switch any from the status bar."
          >
            <Select
              value={defaultWorkspaceEnv}
              onValueChange={(v) => void setDefaultWorkspaceEnv(v)}
            >
              <SelectTrigger
                value={defaultWorkspaceEnv}
                className="h-8 w-40 text-[12px]"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="local" className="text-[12px]">
                  Windows
                </SelectItem>
                {wslDistros.map((d) => (
                  <SelectItem
                    key={d.name}
                    value={`wsl:${d.name}`}
                    className="text-[12px]"
                  >
                    WSL: {d.name}
                  </SelectItem>
                ))}
                {defaultWorkspaceEnv.startsWith("wsl:") &&
                  !wslDistros.some(
                    (d) => `wsl:${d.name}` === defaultWorkspaceEnv,
                  ) && (
                    <SelectItem
                      value={defaultWorkspaceEnv}
                      className="text-[12px]"
                    >
                      {defaultWorkspaceEnv.slice("wsl:".length)} (unavailable)
                    </SelectItem>
                  )}
              </SelectContent>
            </Select>
          </SettingRow>
        )}
        <SettingRow
          title="Letter spacing"
          description="Extra horizontal space between characters (px). Use negative values to tighten Nerd Fonts."
        >
          <Select
            value={String(terminalLetterSpacing)}
            onValueChange={(v) => void setTerminalLetterSpacing(Number(v))}
          >
            <SelectTrigger size="sm" className="h-8 w-28 text-[12px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LETTER_SPACINGS.map((v) => (
                <SelectItem key={v} value={String(v)} className="text-[12px]">
                  {v > 0 ? `+${v}` : v} px
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow title="Font size" description="Terminal text size.">
          <Select
            value={String(terminalFontSize)}
            onValueChange={(v) => void setTerminalFontSize(Number(v))}
          >
            <SelectTrigger size="sm" className="h-8 w-28 text-[12px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TERMINAL_FONT_SIZES.map((size) => (
                <SelectItem
                  key={size}
                  value={String(size)}
                  className="text-[12px]"
                >
                  {size} px
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow
          title="Scrollback"
          description="Lines of history kept per terminal. Higher uses more RAM (~3 KB / line)."
        >
          <Select
            value={String(terminalScrollback)}
            onValueChange={(v) => void setTerminalScrollback(Number(v))}
          >
            <SelectTrigger size="sm" className="h-8 w-36 text-[12px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TERMINAL_SCROLLBACK_PRESETS.map((lines) => (
                <SelectItem
                  key={lines}
                  value={String(lines)}
                  className="text-[12px]"
                >
                  {lines.toLocaleString()} lines
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
      </div>

      <div className="flex flex-col gap-2">
        <Label>Agents</Label>
        <SettingRow
          title="Coding agent notifications"
          description="Alert when Claude Code or Codex running in a terminal needs your input or finishes. Desktop notification when Anbo is unfocused, in-app otherwise."
        >
          <Switch
            checked={agentNotifications}
            onCheckedChange={(v) => void setAgentNotifications(v)}
          />
        </SettingRow>
        <TerminalAgentsSettings />
      </div>

      <div className="flex flex-col gap-2">
        <Label>Startup</Label>
        <div className="flex flex-col gap-2">
          <SettingRow
            title="Launch at login"
            description="Open Anbo automatically when you sign in."
          >
            <Switch
              checked={autostart}
              onCheckedChange={(v) => void onToggleAutostart(v)}
            />
          </SettingRow>
          <SettingRow
            title="Restore window position & size"
            description="Reopen the main window where you left it. Applies on next launch."
          >
            <Switch
              checked={restoreWindowState}
              onCheckedChange={(v) => void setRestoreWindowState(v)}
            />
          </SettingRow>
        </div>
      </div>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[11px] font-medium tracking-tight text-muted-foreground">
      {children}
    </span>
  );
}

function TerminalAgentsSettings() {
  const commands = usePreferencesStore((state) => state.agentLaunchCommands);
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
              Commands available from the New Tab agent launcher.
            </div>
          </div>
          <span className="flex shrink-0 items-center gap-2 text-[10.5px] text-muted-foreground">
            {count} {count === 1 ? "agent" : "agents"}
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
            Edit built-in start commands or add another command-line agent.
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
            <BuiltInAgentRow key={agent.id} agent={agent} commands={commands} />
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
}: {
  agent: (typeof AGENT_LAUNCHERS)[number];
  commands: AgentLaunchCommands;
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
    <div className="grid grid-cols-[16px_minmax(0,1fr)] items-center gap-x-2 gap-y-2 rounded-md border border-border/50 bg-background/35 px-2.5 py-2 sm:grid-cols-[16px_134px_minmax(0,1fr)_56px]">
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

function FontFamilyInput({
  value,
  onCommit,
}: {
  value: string;
  onCommit: (v: string) => void;
}) {
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  // Commit (and trim) only on blur/Enter so a trailing space can be typed
  // mid-edit, e.g. "JetBrains Mono ".
  const commit = () => {
    const next = draft.trim();
    if (next !== draft) setDraft(next);
    if (next !== value) onCommit(next);
  };

  return (
    <SettingRow
      title="Font family"
      description='Nerd Font name for icons (e.g. "CaskaydiaCove Nerd Font Mono"). Leave blank to auto-detect.'
    >
      <input
        type="text"
        value={draft}
        placeholder="Auto-detect"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        className="h-8 w-48 rounded-md border border-border bg-background px-2.5 text-[12px] outline-none focus:border-foreground/40"
      />
    </SettingRow>
  );
}
