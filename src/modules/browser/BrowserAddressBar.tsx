import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  ArrowLeft01Icon,
  ArrowReloadHorizontalIcon,
  ArrowRight01Icon,
  Globe02Icon,
  LinkSquare02Icon,
  Add01Icon,
  ComputerPhoneSyncIcon,
  Remove01Icon,
  AiBrowserIcon,
  DrawingModeIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { DEVICE_PRESETS, devicePreset, RESPONSIVE_DEVICE } from "./devices";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { resolveBrowserInput } from "./browserInput";

type PortPreset = {
  port: number;
  label: string;
  hint: string;
};

// Curated dev-server ports. Ordered by frontend frequency, then backend.
const PORT_PRESETS: readonly PortPreset[] = [
  { port: 5173, label: "Vite", hint: "vite, sveltekit" },
  { port: 5174, label: "Vite (alt)", hint: "second vite instance" },
  { port: 3000, label: "Next.js", hint: "next, express, rails" },
  { port: 3001, label: "Next.js (alt)", hint: "second next instance" },
  { port: 4173, label: "Vite preview", hint: "vite preview" },
  { port: 4200, label: "Angular", hint: "angular cli" },
  { port: 4321, label: "Astro", hint: "astro" },
  { port: 5500, label: "Live Server", hint: "vscode live server" },
  { port: 6006, label: "Storybook", hint: "storybook" },
  { port: 8080, label: "Webpack", hint: "webpack, vue cli" },
  { port: 8081, label: "Metro", hint: "react native metro" },
  { port: 8000, label: "Django / FastAPI", hint: "django, fastapi" },
  { port: 8888, label: "Jupyter", hint: "jupyter notebook" },
  { port: 5000, label: "Flask", hint: "flask" },
  { port: 7860, label: "Gradio", hint: "gradio" },
  { port: 11434, label: "Ollama", hint: "ollama api" },
];

export type BrowserAddressBarHandle = {
  focus: () => void;
};

type Props = {
  url: string;
  onSubmit: (url: string) => void;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
  zoom?: number;
  onZoom?: (zoom: number) => void;
  deviceId?: string;
  onDevice?: (id: string) => void;
  /** Set while a device is emulated, when page zoom would fight the fit. */
  emulatedFit?: number | null;
  effectsEnabled?: boolean;
  onToggleEffects?: () => void;
  designActive?: boolean;
  /** Absent when this pane cannot host design mode (no native page). */
  onToggleDesign?: () => void;
};

export const BrowserAddressBar = forwardRef<BrowserAddressBarHandle, Props>(
  function BrowserAddressBar(
    {
      url,
      onSubmit,
      onBack,
      onForward,
      onReload,
      zoom,
      onZoom,
      deviceId,
      onDevice,
      emulatedFit,
      effectsEnabled,
      onToggleEffects,
      designActive,
      onToggleDesign,
    },
    ref,
  ) {
    const [draft, setDraft] = useState(url);
    const inputRef = useRef<HTMLInputElement>(null);

    // Keep draft in sync when the parent updates the URL externally
    // (AI tool, detected localhost chip, etc.).
    useEffect(() => {
      setDraft(url);
    }, [url]);

    useImperativeHandle(
      ref,
      () => ({
        focus: () => {
          const el = inputRef.current;
          if (!el) return;
          el.focus();
          el.select();
        },
      }),
      [],
    );

    const [notice, setNotice] = useState<string | null>(null);
    const [checkingPort, setCheckingPort] = useState<number | null>(null);

    const submit = () => {
      const next = resolveBrowserInput(draft);
      if (!next) {
        setNotice("Enter a URL, search term, or pick a port preset.");
        return;
      }
      setNotice(null);
      if (next !== url) onSubmit(next);
      else onReload();
    };

    const tryPort = async (port: number) => {
      setNotice(null);
      setCheckingPort(port);
      const url = `http://localhost:${port}`;
      const ok = await probeUrl(url);
      setCheckingPort(null);
      if (!ok) {
        setNotice(`No server listening on :${port}.`);
        return;
      }
      setDraft(url);
      onSubmit(url);
    };

    return (
      <div className="shrink-0 border-b border-border/60 bg-card">
        <div className="flex h-9 items-center gap-1 bg-card px-1.5">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onBack}
            title="Back"
            className="size-7 shrink-0 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <HugeiconsIcon
              icon={ArrowLeft01Icon}
              size={14}
              strokeWidth={1.75}
            />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onForward}
            title="Forward"
            className="size-7 shrink-0 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <HugeiconsIcon
              icon={ArrowRight01Icon}
              size={14}
              strokeWidth={1.75}
            />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onReload}
            title="Reload"
            className="size-7 shrink-0 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <HugeiconsIcon
              icon={ArrowReloadHorizontalIcon}
              size={14}
              strokeWidth={1.75}
            />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                title="Common dev-server ports"
                className="h-7 shrink-0 gap-1 rounded-md px-1.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <HugeiconsIcon
                  icon={Globe02Icon}
                  size={13}
                  strokeWidth={1.75}
                />
                <span className="hidden sm:inline">Ports</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="max-h-80 min-w-56 overflow-y-auto"
            >
              {PORT_PRESETS.map((preset) => (
                <DropdownMenuItem
                  key={preset.port}
                  onSelect={(event) => {
                    event.preventDefault();
                    void tryPort(preset.port);
                  }}
                >
                  <span className="flex-1">{preset.label}</span>
                  <span className="text-xs text-muted-foreground">
                    {checkingPort === preset.port
                      ? "checking..."
                      : `:${preset.port}`}
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <div className="relative flex flex-1 items-center">
            <Input
              ref={inputRef}
              value={draft}
              placeholder="Search Google, enter a URL, or open a workspace HTML file"
              spellCheck={false}
              autoComplete="off"
              className="h-7 w-full bg-background px-2 text-xs placeholder:text-muted-foreground/70 focus-visible:ring-0"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submit();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setDraft(url);
                  inputRef.current?.blur();
                }
              }}
            />
          </div>
          {onToggleDesign && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7 shrink-0"
              onClick={onToggleDesign}
              aria-pressed={designActive}
              aria-label="Design mode"
              title={
                designActive
                  ? "Leave design mode"
                  : "Design mode: mark up this page and send it to an agent"
              }
            >
              <HugeiconsIcon
                icon={DrawingModeIcon}
                size={15}
                strokeWidth={1.75}
                className={
                  designActive ? "text-primary" : "text-muted-foreground"
                }
              />
            </Button>
          )}
          {onToggleEffects && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7 shrink-0"
              onClick={onToggleEffects}
              aria-pressed={effectsEnabled}
              aria-label="Browser automation effects"
              title={
                effectsEnabled
                  ? "Hide automation effects"
                  : "Show automation effects"
              }
            >
              <HugeiconsIcon
                icon={AiBrowserIcon}
                size={15}
                className={
                  effectsEnabled ? "text-primary" : "text-muted-foreground/50"
                }
              />
            </Button>
          )}
          {emulatedFit ? (
            <div
              className="flex shrink-0 items-center px-1 text-[10px] font-medium text-indigo-600 dark:text-indigo-400"
              title="Scaled so the whole emulated viewport fits this pane"
            >
              {Math.round(emulatedFit * 100)}%
            </div>
          ) : null}
          {!emulatedFit && onZoom && zoom !== undefined && (
            // One tight group: two small steppers around the value, which is
            // itself the reset. Fixed-width digits keep it from shifting as the
            // number changes.
            <div className="mr-0.5 flex h-6 shrink-0 items-center overflow-hidden rounded-md border border-border/60">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => onZoom(Math.max(0.1, zoom - 0.1))}
                title="Zoom out"
                className="size-6 shrink-0 rounded-none text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <HugeiconsIcon
                  icon={Remove01Icon}
                  size={12}
                  strokeWidth={1.75}
                />
              </Button>
              <button
                type="button"
                onClick={() => onZoom(1.0)}
                title="Reset zoom"
                className="h-full w-8 shrink-0 border-x border-border/60 font-mono text-[10px] font-medium tabular-nums text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:bg-accent"
              >
                {Math.round(zoom * 100)}%
              </button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => onZoom(Math.min(5.0, zoom + 0.1))}
                title="Zoom in"
                className="size-6 shrink-0 rounded-none text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <HugeiconsIcon icon={Add01Icon} size={12} strokeWidth={1.75} />
              </Button>
            </div>
          )}
          {onDevice && deviceId !== undefined && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  title={
                    deviceId === RESPONSIVE_DEVICE.id
                      ? "Emulate a device viewport"
                      : `Emulating ${devicePreset(deviceId).label}`
                  }
                  aria-label="Device viewport"
                  className={`size-7 shrink-0 rounded-md hover:bg-accent ${
                    deviceId === RESPONSIVE_DEVICE.id
                      ? "text-muted-foreground hover:text-foreground"
                      : "text-indigo-600 dark:text-indigo-400"
                  }`}
                >
                  <HugeiconsIcon
                    icon={ComputerPhoneSyncIcon}
                    size={14}
                    strokeWidth={1.75}
                  />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-48">
                {DEVICE_PRESETS.map((preset) => (
                  <DropdownMenuItem
                    key={preset.id}
                    onSelect={() => onDevice(preset.id)}
                    className={
                      preset.id === deviceId ? "text-foreground" : undefined
                    }
                  >
                    <span className="flex-1">{preset.label}</span>
                    <span className="text-xs text-muted-foreground">
                      {preset.width > 0
                        ? `${preset.width}x${preset.height}`
                        : "off"}
                    </span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => {
              if (url) void openUrl(url).catch(console.error);
            }}
            title="Open in system browser"
            className="size-7 shrink-0 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            disabled={!url}
          >
            <HugeiconsIcon
              icon={LinkSquare02Icon}
              size={14}
              strokeWidth={1.75}
            />
          </Button>
        </div>
        {notice ? (
          <div className="flex items-center gap-1.5 bg-amber-500/8 px-3 py-1 text-[11px] text-amber-600 dark:text-amber-400">
            <span className="truncate">{notice}</span>
            <button
              type="button"
              onClick={() => setNotice(null)}
              className="ml-auto rounded px-1 text-[10px] opacity-80 hover:bg-accent hover:opacity-100"
            >
              Dismiss
            </button>
          </div>
        ) : null}
      </div>
    );
  },
);

async function probeUrl(url: string): Promise<boolean> {
  try {
    await fetch(url, {
      method: "GET",
      mode: "no-cors",
      cache: "no-store",
      signal: AbortSignal.timeout(900),
    });
    return true;
  } catch {
    return false;
  }
}
