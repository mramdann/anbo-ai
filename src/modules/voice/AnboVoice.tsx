import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { STT_PROVIDER_LABELS } from "@/modules/ai/config";
import { useComposer } from "@/modules/ai/lib/composer";
import { notifyNativeBrowserLayout } from "@/modules/browser/nativeVisibility";
import { ORB_WIDTH } from "@/modules/voice/lib/orbPosition";
import { useVoiceOrbPosition } from "@/modules/voice/lib/useVoiceOrbPosition";
import {
  normalizeVoiceText,
  type VoiceTarget,
} from "@/modules/voice/lib/voiceTarget";
import { Cancel01Icon, Copy01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";

type Props = {
  visible: boolean;
  onHide: () => void;
  captureTarget: () => VoiceTarget | null;
};

type FallbackTranscript = {
  text: string;
  message: string;
};

type VoiceVisualStyle = CSSProperties & {
  "--anbo-voice-ring-scale": string;
  "--anbo-voice-ring-opacity": string;
  "--anbo-voice-glow": string;
  "--anbo-voice-bar-1": string;
  "--anbo-voice-bar-2": string;
  "--anbo-voice-bar-3": string;
  "--anbo-voice-bar-4": string;
  "--anbo-voice-bar-5": string;
};

const INITIAL_VISUAL_STYLE = {
  "--anbo-voice-ring-scale": "1",
  "--anbo-voice-ring-opacity": "0",
  "--anbo-voice-glow": "0px",
  "--anbo-voice-bar-1": "3px",
  "--anbo-voice-bar-2": "3px",
  "--anbo-voice-bar-3": "3px",
  "--anbo-voice-bar-4": "3px",
  "--anbo-voice-bar-5": "3px",
} as const;

export function AnboVoice({ visible, onHide, captureTarget }: Props) {
  const composer = useComposer();
  const voice = composer.voice;
  const geometry = useVoiceOrbPosition();
  const targetRef = useRef<VoiceTarget | null>(null);
  const visualRef = useRef<HTMLDivElement>(null);
  const [targetLabel, setTargetLabel] = useState<string | null>(null);
  const [fallback, setFallback] = useState<FallbackTranscript | null>(null);

  const cancel = useCallback(() => {
    voice.cancel();
    targetRef.current = null;
    setTargetLabel(null);
  }, [voice]);

  useEffect(() => {
    if (
      !visible &&
      (voice.requesting || voice.recording || voice.transcribing)
    ) {
      cancel();
    }
  }, [cancel, voice.recording, voice.requesting, voice.transcribing, visible]);

  useEffect(() => {
    if (!voice.requesting && !voice.recording) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      cancel();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [cancel, voice.recording, voice.requesting]);

  useEffect(() => {
    const element = visualRef.current;
    if (!element) return;
    const apply = (level: number, bands: readonly number[]) => {
      element.style.setProperty(
        "--anbo-voice-ring-scale",
        (1.08 + level * 0.34).toFixed(3),
      );
      element.style.setProperty(
        "--anbo-voice-ring-opacity",
        (0.18 + level * 0.5).toFixed(3),
      );
      element.style.setProperty(
        "--anbo-voice-glow",
        `${Math.round(5 + level * 14)}px`,
      );
      bands.forEach((band, index) => {
        element.style.setProperty(
          `--anbo-voice-bar-${index + 1}`,
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: every visual state change can resize the native browser punch holes.
  useEffect(() => {
    notifyNativeBrowserLayout();
  }, [fallback, targetLabel, visible, voice.recording, voice.transcribing]);

  const captureOnPointerDown = (
    event: React.PointerEvent<HTMLButtonElement>,
  ) => {
    if (!voice.requesting && !voice.recording && !voice.transcribing) {
      targetRef.current = captureTarget();
    }
    geometry.onPointerDown(event);
  };

  const insertTranscript = useCallback(
    async (target: VoiceTarget, raw: string) => {
      const text = normalizeVoiceText(raw);
      if (!text) return;
      const result = await target.insert(text);
      if (result.ok) {
        setFallback(null);
        return;
      }
      setFallback({ text, message: result.message });
      toast.error("Transcript was not inserted", {
        description: result.message,
      });
    },
    [],
  );

  const toggleRecording = () => {
    if (geometry.consumeSuppressedClick()) return;
    if (voice.recording) {
      voice.stop();
      return;
    }
    if (voice.requesting || voice.transcribing) return;
    if (!voice.supported) {
      toast.error("Voice input is not supported by this WebView.");
      return;
    }
    if (!voice.hasKey) {
      toast.error(
        `${STT_PROVIDER_LABELS[voice.sttProvider]} is not configured.`,
        { description: "Open Settings, then configure Voice input in Models." },
      );
      return;
    }
    const target = targetRef.current ?? captureTarget();
    if (!target) {
      toast.info("Place the cursor in an input before starting AnboVoice.");
      return;
    }
    if (target.kind === "blocked") {
      void target.insert("");
      toast.error("AnboVoice cannot use this input.", {
        description: "Password and protected fields are not voice targets.",
      });
      return;
    }
    setFallback(null);
    setTargetLabel(target.label);
    targetRef.current = target;
    void voice
      .start((text) => {
        void insertTranscript(target, text).finally(() => {
          targetRef.current = null;
          setTargetLabel(null);
        });
      })
      .then((started) => {
        if (started || targetRef.current !== target) return;
        targetRef.current = null;
        setTargetLabel(null);
      });
  };

  if (!visible) return null;

  const busy = voice.requesting || voice.recording || voice.transcribing;
  const status = voice.requesting
    ? "Requesting microphone"
    : voice.recording
      ? "Listening"
      : voice.transcribing
        ? "Transcribing"
        : null;
  const dockRight =
    geometry.position.x + ORB_WIDTH / 2 >= window.innerWidth / 2;

  return (
    <div
      ref={visualRef}
      className="fixed z-[90] h-8 w-[104px]"
      style={
        {
          ...geometry.style,
          ...INITIAL_VISUAL_STYLE,
        } as VoiceVisualStyle
      }
      data-anbo-voice-overlay
    >
      {status ? (
        <div
          className={cn(
            "absolute top-1/2 z-20 flex -translate-y-1/2 items-center gap-2 rounded-full border border-border/70 bg-popover/95 px-3 py-1.5 text-[11px] text-foreground shadow-xl backdrop-blur-xl",
            dockRight ? "right-[40px]" : "left-[40px]",
          )}
          data-anbo-voice-overlay
        >
          {voice.recording ? (
            <span
              aria-hidden
              className="flex h-3 w-[18px] shrink-0 items-center justify-center gap-[1.5px]"
            >
              {([1, 2, 3, 4, 5] as const).map((bar) => (
                <span
                  key={bar}
                  className="w-[1.5px] rounded-full bg-primary transition-[height] duration-75 ease-out motion-reduce:transition-none"
                  style={{ height: `var(--anbo-voice-bar-${bar})` }}
                />
              ))}
            </span>
          ) : voice.requesting ? (
            <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-primary" />
          ) : (
            <Spinner className="size-3 shrink-0" />
          )}
          <span className="whitespace-nowrap font-medium">{status}</span>
          {targetLabel ? (
            <span className="max-w-36 truncate whitespace-nowrap text-muted-foreground">
              {targetLabel}
            </span>
          ) : null}
          {voice.recording ? (
            <button
              type="button"
              tabIndex={-1}
              onPointerDown={(event) => event.preventDefault()}
              onClick={cancel}
              className="ml-0.5 flex size-5 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
              title="Cancel recording"
            >
              <HugeiconsIcon icon={Cancel01Icon} size={11} strokeWidth={2} />
            </button>
          ) : null}
        </div>
      ) : null}

      {fallback ? (
        <div
          className={cn(
            "absolute top-1/2 z-20 w-72 -translate-y-1/2 rounded-xl border border-border/70 bg-popover/95 p-3 text-xs shadow-xl backdrop-blur-xl",
            dockRight ? "right-[112px]" : "left-[112px]",
          )}
          data-anbo-voice-overlay
        >
          <div className="mb-1 font-medium text-foreground">
            Transcript kept safely
          </div>
          <div className="mb-2 text-[10.5px] leading-relaxed text-muted-foreground">
            {fallback.message}
          </div>
          <div className="max-h-24 overflow-auto whitespace-pre-wrap rounded-md bg-muted/60 p-2 text-foreground">
            {fallback.text}
          </div>
          <div className="mt-2 flex justify-end gap-1">
            <button
              type="button"
              onClick={() => setFallback(null)}
              className="rounded-md px-2 py-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              Dismiss
            </button>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(fallback.text).then(
                  () => toast.success("Transcript copied"),
                  () => toast.error("Could not copy the transcript"),
                );
              }}
              className="flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-primary-foreground hover:opacity-90"
            >
              <HugeiconsIcon icon={Copy01Icon} size={11} strokeWidth={2} />
              Copy
            </button>
          </div>
        </div>
      ) : null}

      {voice.recording ? (
        <>
          <span
            aria-hidden
            className={cn(
              "pointer-events-none absolute top-0 z-0 size-8 rounded-full border border-primary/70 opacity-[var(--anbo-voice-ring-opacity)] transition-[transform,opacity] duration-75 ease-out [transform:scale(var(--anbo-voice-ring-scale))] motion-reduce:transform-none motion-reduce:transition-none",
              dockRight ? "right-0" : "left-0",
            )}
          />
          <span
            aria-hidden
            className={cn(
              "pointer-events-none absolute top-0 z-0 size-8 rounded-full bg-primary/15 opacity-[var(--anbo-voice-ring-opacity)] transition-[transform,opacity] duration-100 ease-out [transform:scale(calc(var(--anbo-voice-ring-scale)_+_0.16))] motion-reduce:transform-none motion-reduce:transition-none",
              dockRight ? "right-0" : "left-0",
            )}
          />
        </>
      ) : null}

      <button
        type="button"
        tabIndex={-1}
        aria-label={voice.recording ? "Stop AnboVoice" : "Start AnboVoice"}
        onPointerDown={captureOnPointerDown}
        onClick={toggleRecording}
        onContextMenu={(event) => {
          event.preventDefault();
          cancel();
          onHide();
        }}
        className={cn(
          "group relative z-10 flex h-8 touch-none items-center rounded-full border shadow-lg backdrop-blur-xl transition-[width,padding,color,background-color,border-color,box-shadow,opacity] duration-150",
          "border-primary/55 bg-popover/90 text-muted-foreground hover:border-primary/75 hover:bg-popover hover:text-foreground hover:shadow-xl",
          busy
            ? cn(
                "w-8 justify-center p-0",
                dockRight ? "ml-auto" : "mr-auto",
              )
            : "w-[104px] justify-center gap-1.5 px-1.5 opacity-95 hover:opacity-100",
          voice.recording &&
            "border-primary/60 bg-popover text-primary opacity-100 shadow-[0_0_var(--anbo-voice-glow)_color-mix(in_oklab,var(--primary)_28%,transparent)]",
          voice.transcribing &&
            "border-primary/50 bg-primary/10 text-primary opacity-100",
        )}
      >
        <img
          src="/logo.svg"
          alt=""
          draggable={false}
          className={cn(
            "pointer-events-none size-[14px] select-none rounded-[4px] shadow-sm transition-transform duration-150",
            voice.recording && "scale-[1.03]",
          )}
        />
        {!busy ? (
          <span className="pointer-events-none mr-0.5 truncate text-xs leading-[14px] font-bold tracking-[-0.01em] text-foreground">
            AnboVoice
          </span>
        ) : null}
      </button>
    </div>
  );
}
