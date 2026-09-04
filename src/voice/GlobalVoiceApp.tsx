import { cn } from "@/lib/utils";
import { useWhisperRecording } from "@/modules/ai/hooks/useWhisperRecording";
import { getAllKeys } from "@/modules/ai/lib/keyring";
import { useChatStore } from "@/modules/ai/store/chatStore";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { onKeysChanged } from "@/modules/settings/store";
import {
  captureGlobalVoiceTarget,
  clearGlobalVoiceTarget,
  GLOBAL_VOICE_TOGGLE_EVENT,
  type GlobalVoiceTarget,
  insertGlobalVoiceText,
  rememberGlobalVoiceForeground,
} from "@/modules/voice/lib/globalVoice";
import { resolveVoicePress } from "@/modules/voice/lib/voicePress";
import { PhysicalPosition } from "@tauri-apps/api/dpi";
import { listen } from "@tauri-apps/api/event";
import { availableMonitors, getCurrentWindow } from "@tauri-apps/api/window";
import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

type VisualStyle = CSSProperties & {
  "--voice-ring-scale": string;
  "--voice-ring-opacity": string;
  "--voice-glow": string;
  "--voice-bar-1": string;
  "--voice-bar-2": string;
  "--voice-bar-3": string;
  "--voice-bar-4": string;
  "--voice-bar-5": string;
};

const INITIAL_STYLE = {
  "--voice-ring-scale": "1",
  "--voice-ring-opacity": "0",
  "--voice-glow": "0px",
  "--voice-bar-1": "3px",
  "--voice-bar-2": "3px",
  "--voice-bar-3": "3px",
  "--voice-bar-4": "3px",
  "--voice-bar-5": "3px",
} as const;

const DRAG_THRESHOLD_PX = 4;
const POSITION_STORAGE_KEY = "anbo-global-voice-position";

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function GlobalVoiceApp() {
  const initPreferences = usePreferencesStore((state) => state.init);
  const setApiKeys = useChatStore((state) => state.setApiKeys);
  const visualRef = useRef<HTMLDivElement>(null);
  const targetRef = useRef<GlobalVoiceTarget | null>(null);
  const actionRef = useRef(false);
  const abortStartRef = useRef(false);
  const targetPreparationRef = useRef<Promise<void> | null>(null);
  const hoveredRef = useRef(false);
  const suppressClickRef = useRef(false);
  const dragRef = useRef<{
    pointerId: number;
    x: number;
    y: number;
    dragging: boolean;
  } | null>(null);
  const [inserting, setInserting] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fallbackTranscript, setFallbackTranscript] = useState<string | null>(
    null,
  );

  useEffect(() => {
    void initPreferences();
  }, [initPreferences]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const appWindow = getCurrentWindow();
    void (async () => {
      try {
        const raw = window.localStorage.getItem(POSITION_STORAGE_KEY);
        if (raw) {
          const saved = JSON.parse(raw) as { x?: unknown; y?: unknown };
          if (typeof saved.x === "number" && typeof saved.y === "number") {
            const x = saved.x;
            const y = saved.y;
            const monitors = await availableMonitors();
            const visible = monitors.some(({ workArea }) => {
              const right = workArea.position.x + workArea.size.width;
              const bottom = workArea.position.y + workArea.size.height;
              return (
                x >= workArea.position.x - 80 &&
                x <= right - 24 &&
                y >= workArea.position.y - 24 &&
                y <= bottom - 16
              );
            });
            if (visible) {
              await appWindow.setPosition(new PhysicalPosition(x, y));
            }
          }
        }
      } catch {
        window.localStorage.removeItem(POSITION_STORAGE_KEY);
      }
      if (disposed) return;
      unlisten = await appWindow.onMoved(({ payload }) => {
        window.localStorage.setItem(
          POSITION_STORAGE_KEY,
          JSON.stringify({ x: payload.x, y: payload.y }),
        );
      });
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    let alive = true;
    const reload = () => {
      void getAllKeys().then((keys) => {
        if (alive) setApiKeys(keys);
      });
    };
    reload();
    const unlisten = onKeysChanged(reload);
    return () => {
      alive = false;
      void unlisten.then((dispose) => dispose());
    };
  }, [setApiKeys]);

  const prepareTarget = useCallback(() => {
    const preparation = rememberGlobalVoiceForeground().catch(() => {});
    targetPreparationRef.current = preparation;
    return preparation;
  }, []);

  const finishInsert = useCallback(async (text: string) => {
    setInserting(true);
    try {
      await insertGlobalVoiceText(text);
      setError(null);
      setFallbackTranscript(null);
    } catch (cause) {
      const detail = message(cause);
      setError(detail);
      setFallbackTranscript(text);
      try {
        await navigator.clipboard.writeText(text);
        setError(`${detail} Transcript copied to the clipboard.`);
      } catch {
        // The transcript remains in memory and can be copied on right click.
      }
    } finally {
      targetRef.current = null;
      setInserting(false);
      if (hoveredRef.current) void prepareTarget();
    }
  }, [prepareTarget]);

  const settleTarget = useCallback(() => {
    if (!targetRef.current) return;
    targetRef.current = null;
    void clearGlobalVoiceTarget()
      .catch(() => {})
      .then(() => {
        if (hoveredRef.current) void prepareTarget();
      });
  }, [prepareTarget]);

  const handleVoiceError = useCallback(
    (detail: string) => {
      setError(detail);
      settleTarget();
    },
    [settleTarget],
  );

  const voice = useWhisperRecording({
    onResult: finishInsert,
    onError: handleVoiceError,
    onSettled: settleTarget,
  });

  useEffect(() => {
    const element = visualRef.current;
    if (!element) return;
    const apply = (level: number, bands: readonly number[]) => {
      element.style.setProperty(
        "--voice-ring-scale",
        (1.08 + level * 0.34).toFixed(3),
      );
      element.style.setProperty(
        "--voice-ring-opacity",
        (0.18 + level * 0.5).toFixed(3),
      );
      element.style.setProperty(
        "--voice-glow",
        `${Math.round(5 + level * 14)}px`,
      );
      bands.forEach((band, index) => {
        element.style.setProperty(
          `--voice-bar-${index + 1}`,
          `${(3 + band * 9).toFixed(1)}px`,
        );
      });
    };
    if (!voice.recording) {
      apply(0, [0, 0, 0, 0, 0]);
      return;
    }
    return voice.audioMeter.subscribe((frame) => {
      apply(frame.level, frame.bands);
    });
  }, [voice.audioMeter, voice.recording]);

  const cancel = useCallback(() => {
    voice.cancel();
    targetRef.current = null;
    actionRef.current = false;
    void clearGlobalVoiceTarget()
      .catch(() => {})
      .then(() => {
        if (hoveredRef.current) void prepareTarget();
      });
  }, [prepareTarget, voice]);

  const toggle = useCallback(async () => {
    const action = resolveVoicePress({
      recording: voice.recording,
      requesting: voice.requesting,
      transcribing: voice.transcribing,
      inserting,
      starting: actionRef.current,
    });
    if (action === "stop") {
      voice.stop();
      return;
    }
    if (action === "cancel") {
      cancel();
      return;
    }
    if (action === "abortStart") {
      abortStartRef.current = true;
      return;
    }
    if (!voice.supported) {
      setError(
        "Microphone recording is not supported by this Windows WebView.",
      );
      return;
    }
    if (!voice.hasKey) {
      setError("Configure the selected voice provider in Anbo Settings first.");
      return;
    }

    actionRef.current = true;
    abortStartRef.current = false;
    setPreparing(true);
    setError(null);
    setFallbackTranscript(null);
    try {
      const target = await captureGlobalVoiceTarget();
      if (abortStartRef.current) {
        targetRef.current = null;
        await clearGlobalVoiceTarget();
        return;
      }
      targetRef.current = target;
      const started = await voice.start(finishInsert);
      if (!started || abortStartRef.current) {
        if (started) voice.cancel();
        targetRef.current = null;
        await clearGlobalVoiceTarget();
      }
    } catch (cause) {
      targetRef.current = null;
      setError(message(cause));
      await clearGlobalVoiceTarget();
    } finally {
      abortStartRef.current = false;
      actionRef.current = false;
      setPreparing(false);
    }
  }, [cancel, finishInsert, inserting, voice]);

  const toggleRef = useRef(toggle);
  toggleRef.current = toggle;

  // Registered once. Keying this on `toggle` tore the listener down on every
  // render and re-armed it across an async round trip, dropping any hotkey
  // press that landed in the gap.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen(GLOBAL_VOICE_TOGGLE_EVENT, () => {
      void toggleRef.current();
    }).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      cancel();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [cancel]);

  const pending =
    preparing || voice.requesting || voice.transcribing || inserting;
  const busy = voice.recording || pending;

  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    // Prevent the button's default focus action from activating this
    // non-focusable overlay and stealing the real text target underneath it.
    event.preventDefault();
    suppressClickRef.current = false;
    dragRef.current = {
      pointerId: event.pointerId,
      x: event.screenX,
      y: event.screenY,
      dragging: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId || drag.dragging) return;
    // While busy the orb is a stop control. A few pixels of hand drift would
    // otherwise start a window drag, suppress the click, and leave the
    // recording running to the five minute cap with no visible change.
    if (busy) return;
    if (
      Math.hypot(event.screenX - drag.x, event.screenY - drag.y) <
      DRAG_THRESHOLD_PX
    ) {
      return;
    }
    drag.dragging = true;
    suppressClickRef.current = true;
    void getCurrentWindow().startDragging();
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const onClick = () => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    const preparation = targetPreparationRef.current;
    targetPreparationRef.current = null;
    void (async () => {
      await preparation;
      await toggle();
    })();
  };

  const label = error
    ? `AnboVoice error: ${error}`
    : voice.recording
      ? `Stop AnboVoice recording for ${targetRef.current?.windowTitle ?? "focused app"}`
      : preparing || voice.requesting
        ? "AnboVoice is starting"
        : voice.transcribing || inserting
          ? "AnboVoice is transcribing"
          : "Start global AnboVoice";

  return (
    <div
      ref={visualRef}
      className="relative flex size-full items-center justify-center"
      style={INITIAL_STYLE as VisualStyle}
    >
      {voice.recording ? (
        <span
          aria-hidden
          className="pointer-events-none absolute size-8 rounded-full border border-primary/65 opacity-[var(--voice-ring-opacity)] [transform:scale(var(--voice-ring-scale))]"
        />
      ) : null}
      {pending ? (
        <span
          aria-hidden
          className="anbo-voice-busy-ring pointer-events-none absolute size-9 rounded-full"
        />
      ) : null}
      <button
        type="button"
        aria-label={label}
        onPointerEnter={() => {
          hoveredRef.current = true;
          void prepareTarget();
        }}
        onPointerLeave={() => {
          hoveredRef.current = false;
          targetPreparationRef.current = null;
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onClick={onClick}
        onPointerCancel={() => {
          dragRef.current = null;
          suppressClickRef.current = false;
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          if (fallbackTranscript) {
            void navigator.clipboard.writeText(fallbackTranscript);
          } else {
            cancel();
          }
        }}
        className={cn(
          "relative z-10 flex h-8 touch-none items-center justify-center rounded-full border bg-popover/90 shadow-lg backdrop-blur-xl transition-[width,padding,color,background-color,border-color,box-shadow] duration-150",
          busy ? "w-8 p-0" : "w-[104px] gap-1.5 px-1.5",
          !busy &&
            !error &&
            "border-primary/55 text-muted-foreground hover:border-primary/75 hover:text-foreground",
          voice.recording &&
            "border-primary/70 text-primary shadow-[0_0_var(--voice-glow)_color-mix(in_oklab,var(--primary)_28%,transparent)]",
          (voice.requesting || voice.transcribing || inserting) &&
            "border-primary/55 bg-primary/10 text-primary",
          error && "border-destructive/80 text-destructive",
        )}
      >
        {voice.recording ? (
          <span
            aria-hidden
            className="flex h-3 w-[18px] items-center justify-center gap-[1.5px]"
          >
            {([1, 2, 3, 4, 5] as const).map((bar) => (
              <span
                key={bar}
                className="w-[1.5px] rounded-full bg-primary transition-[height] duration-75"
                style={{ height: `var(--voice-bar-${bar})` }}
              />
            ))}
          </span>
        ) : (
          <img
            src="/logo.svg"
            alt=""
            draggable={false}
            className="pointer-events-none size-[14px] select-none rounded-[4px] shadow-sm"
          />
        )}
        {!busy ? (
          <span className="pointer-events-none mr-0.5 truncate text-xs leading-[14px] font-bold tracking-[-0.01em] text-foreground">
            AnboVoice
          </span>
        ) : null}
      </button>
    </div>
  );
}
