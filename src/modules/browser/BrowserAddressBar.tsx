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
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  DEVICE_PRESETS,
  devicePreset,
  RESPONSIVE_DEVICE,
} from "./devices";
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
  aiAction?: string | null;
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
      aiAction,
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
              <DropdownMenuContent align="start" className="min-w-48">
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
            {aiAction && (
              <div className="absolute right-8 z-10 flex items-center gap-1.5 rounded-md border border-indigo-500/40 bg-indigo-500/15 px-2 py-0.5 text-[10px] font-medium text-indigo-700 shadow-sm backdrop-blur-sm dark:border-indigo-400/30 dark:text-indigo-300 dark:bg-indigo-900/30 animate-in fade-in zoom-in duration-200 pointer-events-none">
                <span className="flex h-1.5 w-1.5 rounded-full bg-indigo-500 shadow-[0_0_8px_rgba(99,102,241,1)] animate-pulse" />
                AI: {aiAction}
              </div>
            )}
          </div>
          {emulatedFit ? (
            <div
              className="flex shrink-0 items-center px-1 text-[10px] font-medium text-indigo-600 dark:text-indigo-400"
              title="Scaled so the whole emulated viewport fits this pane"
            >
              {Math.round(emulatedFit * 100)}%
            </div>
          ) : null}
          {!emulatedFit && onZoom && zoom !== undefined && (
            <div className="flex shrink-0 items-center gap-0.5 pl-1 mr-1">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => onZoom(Math.max(0.1, zoom - 0.1))}
                title="Zoom Out"
                className="size-7 shrink-0 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <HugeiconsIcon icon={Remove01Icon} size={14} strokeWidth={1.75} />
              </Button>
              <div 
                className="flex w-9 cursor-pointer items-center justify-center text-[10px] font-medium text-muted-foreground hover:text-foreground"
                onClick={() => onZoom(1.0)}
                title="Reset Zoom"
              >
                {Math.round(zoom * 100)}%
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => onZoom(Math.min(5.0, zoom + 0.1))}
                title="Zoom In"
                className="size-7 shrink-0 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <HugeiconsIcon icon={Add01Icon} size={14} strokeWidth={1.75} />
              </Button>
            </div>
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
