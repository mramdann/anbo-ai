const UpdateButton = lazy(() =>
  import("@/modules/updater/UpdateButton").then((m) => ({
    default: m.UpdateButton,
  })),
);
import { Button } from "@/components/ui/button";
import { WindowControls } from "@/components/WindowControls";
import { IS_MAC, USE_CUSTOM_WINDOW_CONTROLS } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { NotificationBell } from "@/modules/agents";
import type { WorkspaceEnv } from "@/modules/workspace";
import {
  AudioWaveformIcon,
  CommandIcon,
  Settings01Icon,
  SidebarLeftIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { getVersion } from "@tauri-apps/api/app";
import {
  lazy,
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
  useState,
  Suspense,
} from "react";
import {
  SearchInline,
  type SearchInlineHandle,
  type SearchTarget,
} from "./SearchInline";

type Props = {
  onToggleSidebar: () => void;
  onOpenCommandPalette: () => void;
  onActivateAgent: (tabId: number, leafId: number) => void;
  onActivateLocalAgent: () => void;
  onOpenSettings: () => void;
  voiceVisible: boolean;
  onToggleVoice: () => void;
  spaceSwitcher: ReactNode;
  searchTarget: SearchTarget;
  searchRef: RefObject<SearchInlineHandle | null>;
  workspaceRoot: string | null;
  workspace: WorkspaceEnv;
};

const COMPACT_WIDTH = 720;

export function Header({
  onToggleSidebar,
  onOpenCommandPalette,
  onActivateAgent,
  onActivateLocalAgent,
  onOpenSettings,
  voiceVisible,
  onToggleVoice,
  spaceSwitcher,
  searchTarget,
  searchRef,
  workspaceRoot,
  workspace,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  // The mark doubles as the one place the running version is a hover away.
  // Outside Tauri (tests, a plain browser) there is no version to ask for.
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    void getVersion()
      .then(setVersion)
      .catch(() => {});
  }, []);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      setCompact(w < COMPACT_WIDTH);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const settingsButton = (
    <Button
      variant="ghost"
      size="icon"
      className="size-6 shrink-0 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
      onClick={onOpenSettings}
      title="Settings"
    >
      <HugeiconsIcon
        icon={Settings01Icon}
        size={14}
        strokeWidth={1.75}
        className="size-3.5"
      />
    </Button>
  );

  const voiceButton = (
    <Button
      variant="ghost"
      size="icon"
      className={cn(
        "size-6 shrink-0 rounded-md hover:bg-accent hover:text-foreground",
        voiceVisible ? "text-primary" : "text-muted-foreground",
      )}
      onClick={onToggleVoice}
      title={voiceVisible ? "Hide AnboVoice" : "Show AnboVoice"}
      aria-pressed={voiceVisible}
    >
      <HugeiconsIcon
        icon={AudioWaveformIcon}
        size={14}
        strokeWidth={1.75}
        className="size-3.5"
      />
    </Button>
  );

  const search = (
    <SearchInline ref={searchRef} target={searchTarget} compact={compact} />
  );

  return (
    <div
      ref={rootRef}
      data-tauri-drag-region
      className={`grid h-8 shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-2 border-b border-border/60 bg-card select-none ${
        IS_MAC ? "pr-2 pl-20" : "pr-0 pl-2"
      }`}
    >
      {/* Left: the mark, then where you are. The mark is part of the drag
          handle, so the corner still moves the window. */}
      <div className="flex min-w-0 items-center gap-2" data-tauri-drag-region>
        <span
          data-tauri-drag-region
          title={version ? `Anbo v${version}` : "Anbo"}
          className="flex size-6 shrink-0 items-center justify-center"
        >
          <img
            src="/logo.svg"
            alt="Anbo"
            draggable={false}
            className="pointer-events-none size-[18px] rounded-[5px]"
          />
        </span>
        {spaceSwitcher}
        {/* Nothing about an update is needed to draw the app, so it arrives
            after the first paint rather than in the startup bundle. */}
        <Suspense fallback={null}>
          <UpdateButton />
        </Suspense>
        <div data-tauri-drag-region className="h-full min-w-2 flex-1" />
      </div>

      {/* Centre: search, centred on the window rather than on what is left
          over, because the side columns share the remaining width equally.
          Below the compact width it folds into the right-hand run as an
          icon instead. */}
      <div
        className="flex min-w-0 items-center justify-center"
        data-tauri-drag-region
      >
        {!compact && search}
      </div>

      {/* Right: everything that acts on the app, in one run — the same on
          every platform, so nothing has to be placed twice. Every control is
          the same 24px square at the same 4px gap, so the run reads as one
          evenly spaced row, ordered from the content outwards: the panel
          toggle, then the things you act with (palette, notifications,
          voice), then settings as the last stop before the window
          controls. */}
      <div
        className="flex min-w-0 items-center justify-end gap-2"
        data-tauri-drag-region
      >
        <div className="flex shrink-0 items-center gap-1">
          <Button
            onClick={onToggleSidebar}
            title="Toggle sidebar"
            variant="ghost"
            size="icon"
            className="size-6 shrink-0 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <HugeiconsIcon
              icon={SidebarLeftIcon}
              size={14}
              strokeWidth={1.75}
              className="size-3.5"
            />
          </Button>
          {compact && search}
          <Button
            size="icon"
            variant="ghost"
            onClick={onOpenCommandPalette}
            title="Command palette"
            className="size-6 shrink-0 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <HugeiconsIcon
              icon={CommandIcon}
              size={14}
              strokeWidth={1.75}
              className="size-3.5"
            />
          </Button>
          <NotificationBell
            onActivate={onActivateAgent}
            onActivateLocal={onActivateLocalAgent}
            workspaceRoot={workspaceRoot}
            workspace={workspace}
          />
          {voiceButton}
          {settingsButton}
        </div>

        {USE_CUSTOM_WINDOW_CONTROLS && (
          <>
            <span className="h-4 w-px shrink-0 bg-border/60" />
            <WindowControls />
          </>
        )}
      </div>
    </div>
  );
}
