import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import {
  type WhispercppAcceleration,
  type WhispercppModel,
  WHISPERCPP_DEFAULT_BASE_URL,
} from "@/modules/ai/config";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  setWhispercppAcceleration,
  setWhispercppAutoStart,
  setWhispercppBaseURL,
  setWhispercppModel,
} from "@/modules/settings/store";
import {
  cancelWhisperRuntimeInstall,
  formatRuntimeBytes,
  getWhisperRuntimeStatus,
  installWhisperRuntime,
  startWhisperRuntime,
  stopWhisperRuntime,
  uninstallWhisperRuntime,
  WHISPER_RUNTIME_PROGRESS_EVENT,
  type WhisperInstallProgress,
  type WhisperRuntimeStatus,
} from "@/modules/voice/lib/whisperRuntime";
import {
  Cancel01Icon,
  Delete02Icon,
  Download01Icon,
  PlayIcon,
  StopCircleIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useState } from "react";

const ACCELERATION_META: Record<
  WhispercppAcceleration,
  { label: string; download: string; note: string }
> = {
  auto: {
    label: "Automatic",
    download: "",
    note: "Picks NVIDIA when a driver is present, OpenBLAS otherwise",
  },
  cpu: { label: "CPU only", download: "8 MB", note: "Smallest download" },
  blas: {
    label: "CPU + OpenBLAS",
    download: "21 MB",
    note: "Faster matrix maths on any processor",
  },
  cuda: {
    label: "NVIDIA GPU",
    download: "270 MB",
    note: "Needs an NVIDIA driver. Much faster, much larger",
  },
};

const MODEL_META: Record<
  WhispercppModel,
  { label: string; download: string; note: string }
> = {
  tiny: {
    label: "Tiny",
    download: "74 MB",
    note: "Fastest, lower accuracy",
  },
  base: {
    label: "Base",
    download: "141 MB",
    note: "Recommended balance",
  },
  small: {
    label: "Small",
    download: "465 MB",
    note: "More accurate, slower",
  },
};

type Operation = "install" | "start" | "stop" | "uninstall" | null;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function WhisperRuntimeSettings() {
  const model = usePreferencesStore((state) => state.whispercppModel);
  const acceleration = usePreferencesStore(
    (state) => state.whispercppAcceleration,
  );
  const autoStart = usePreferencesStore((state) => state.whispercppAutoStart);
  const baseURL = usePreferencesStore((state) => state.whispercppBaseURL);
  const [urlDraft, setUrlDraft] = useState(baseURL);
  const [status, setStatus] = useState<WhisperRuntimeStatus | null>(null);
  const [operation, setOperation] = useState<Operation>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmUninstall, setConfirmUninstall] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const next = await getWhisperRuntimeStatus();
      setStatus(next);
      if (next.error) setError(next.error);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, []);

  useEffect(() => setUrlDraft(baseURL), [baseURL]);

  useEffect(() => {
    void refresh();
    const refreshTimer = window.setInterval(() => void refresh(), 2_000);
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<WhisperInstallProgress>(
      WHISPER_RUNTIME_PROGRESS_EVENT,
      (event) => {
        if (disposed) return;
        setStatus((current) =>
          current
            ? {
                ...current,
                phase: "installing",
                installing: true,
                progress: event.payload,
              }
            : current,
        );
      },
    ).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    });
    return () => {
      disposed = true;
      window.clearInterval(refreshTimer);
      unlisten?.();
    };
  }, [refresh]);

  const selectedInstalled = status?.installedModels.includes(model) ?? false;
  const busy = operation !== null || status?.installing === true;
  const installingNow = status?.installing === true || operation === "install";
  // Loading a model and waiting for the server to bind its port takes seconds
  // and reports no progress, so it needs its own indeterminate state rather
  // than borrowing the install bar.
  const startingNow = operation === "start";
  // The backend answers with the model the process is actually serving, which
  // drifts from the dropdown the moment someone picks another installed one.
  const runningModel = status?.running ? status.model : null;
  const modelDrifted = runningModel !== null && runningModel !== model;
  // Anything on disk should be removable. `installed` also requires a model,
  // so a cancelled download would otherwise strand the extracted runtime with
  // no way to reclaim the space.
  // "auto" is resolved by the backend, so compare against what it recommends
  // rather than against the literal preference.
  const wantedVariant =
    acceleration === "auto" ? status?.recommendedVariant : acceleration;
  const backendWantsGpu = wantedVariant === "cuda";
  const backendDrifted =
    status?.variant != null &&
    wantedVariant != null &&
    status.variant !== wantedVariant;
  const hasFilesOnDisk =
    (status?.installed ?? false) || (status?.sizeBytes ?? 0) > 0;
  const progressPercent = useMemo(() => {
    const progress = status?.progress;
    if (!progress || progress.total <= 0) return 0;
    return Math.min(
      100,
      Math.round((progress.downloaded / progress.total) * 100),
    );
  }, [status?.progress]);

  const run = async (
    nextOperation: Exclude<Operation, null>,
    action: () => Promise<WhisperRuntimeStatus>,
  ) => {
    setOperation(nextOperation);
    setError(null);
    try {
      const next = await action();
      setStatus(next);
      if (next.baseUrl) {
        await setWhispercppBaseURL(next.baseUrl);
      }
      return next;
    } catch (cause) {
      const message = errorMessage(cause);
      if (!message.toLowerCase().includes("cancelled")) setError(message);
      await refresh();
      return null;
    } finally {
      setOperation(null);
    }
  };

  const installAndStart = async () => {
    setOperation("install");
    setError(null);
    try {
      if (status?.running) await stopWhisperRuntime();
      await installWhisperRuntime(model, acceleration);
      // The backend clears its progress the moment the install returns, so
      // holding "install" here would drop the bar back to an empty
      // "Downloading runtime 0%" for the whole of the start, next to a Cancel
      // button that no longer has an install to cancel.
      setOperation("start");
      const next = await startWhisperRuntime(model);
      setStatus(next);
      if (next.baseUrl) await setWhispercppBaseURL(next.baseUrl);
    } catch (cause) {
      const message = errorMessage(cause);
      if (!message.toLowerCase().includes("cancelled")) setError(message);
      await refresh();
    } finally {
      setOperation(null);
    }
  };

  return (
    <div className="flex flex-col gap-2.5">
      <div className="rounded-lg border border-border/60 bg-background/35 p-2.5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-[11.5px] font-medium">Local runtime</span>
              <Badge
                variant={status?.running ? "default" : "secondary"}
                className="h-4 px-1.5 text-[9.5px]"
              >
                {status?.supported === false
                  ? "Unavailable"
                  : status?.running
                    ? "Running"
                    : status?.installing
                      ? "Installing"
                      : status?.installed
                        ? "Stopped"
                        : "Not installed"}
              </Badge>
            </div>
            <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
              {status?.supported === false
                ? "Managed install requires Windows x64. An external loopback endpoint still works."
                : "Private to Anbo. Nothing is added to PATH or installed system-wide."}
            </p>
          </div>
          {status?.sizeBytes ? (
            <span className="shrink-0 text-[10px] text-muted-foreground">
              {formatRuntimeBytes(status.sizeBytes)}
            </span>
          ) : null}
        </div>

        <div className="mt-2.5 flex items-center gap-2">
          <span className="w-16 shrink-0 text-[10.5px] text-muted-foreground">
            Model
          </span>
          <Select
            value={model}
            onValueChange={(value) =>
              void setWhispercppModel(value as WhispercppModel)
            }
            disabled={busy}
          >
            <SelectTrigger
              size="sm"
              className="h-7 min-w-44 flex-1 text-[11px]"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(MODEL_META) as WhispercppModel[]).map((id) => (
                <SelectItem key={id} value={id} className="text-[11px]">
                  {MODEL_META[id].label} ({MODEL_META[id].download})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <p className="ml-18 mt-1 text-[9.5px] text-muted-foreground">
          {MODEL_META[model].note}
          {selectedInstalled ? " / Installed" : ""}
        </p>

        <div className="mt-2 flex items-center gap-2">
          <span className="w-16 shrink-0 text-[10.5px] text-muted-foreground">
            Compute
          </span>
          <Select
            value={acceleration}
            onValueChange={(value) =>
              void setWhispercppAcceleration(value as WhispercppAcceleration)
            }
            disabled={busy}
          >
            <SelectTrigger
              size="sm"
              className="h-7 min-w-44 flex-1 text-[11px]"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(
                Object.keys(ACCELERATION_META) as WhispercppAcceleration[]
              ).map((id) => (
                <SelectItem key={id} value={id} className="text-[11px]">
                  {ACCELERATION_META[id].label}
                  {ACCELERATION_META[id].download
                    ? ` (${ACCELERATION_META[id].download})`
                    : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <p className="ml-18 mt-1 text-[9.5px] text-muted-foreground">
          {acceleration === "auto" && status
            ? `${ACCELERATION_META[status.recommendedVariant].label} on this machine`
            : ACCELERATION_META[acceleration].note}
          {status && !status.gpuAvailable && backendWantsGpu
            ? " / No NVIDIA driver found here"
            : ""}
        </p>
        {backendDrifted ? (
          <p className="ml-18 mt-1 text-[9.5px] text-amber-600 dark:text-amber-500">
            Installed backend is {status?.variantLabel}. Reinstall to change it.
          </p>
        ) : null}

        {installingNow ? (
          <div className="mt-3 rounded-md bg-muted/45 px-2.5 py-2">
            <div className="flex items-center justify-between text-[10px]">
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <Spinner className="size-3" />
                {status?.progress?.phase === "model"
                  ? "Downloading model"
                  : status?.progress?.phase === "finalizing"
                    ? "Finalizing"
                    : "Downloading runtime"}
              </span>
              <span className="font-mono text-muted-foreground">
                {progressPercent}%
              </span>
            </div>
            <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-[width]"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              className="mt-1.5 h-5 px-1.5 text-[9.5px]"
              onClick={() => void cancelWhisperRuntimeInstall()}
            >
              <HugeiconsIcon icon={Cancel01Icon} size={10} strokeWidth={2} />
              Cancel
            </Button>
          </div>
        ) : startingNow ? (
          <div className="mt-3 flex items-center gap-1.5 rounded-md bg-muted/45 px-2.5 py-2 text-[10px] text-muted-foreground">
            <Spinner className="size-3" />
            Starting {MODEL_META[model].label} server
          </div>
        ) : (
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            {!selectedInstalled ? (
              <Button
                type="button"
                size="sm"
                className="h-7 text-[10.5px]"
                disabled={busy || !status || !status.supported}
                onClick={() => void installAndStart()}
              >
                <HugeiconsIcon
                  icon={Download01Icon}
                  size={12}
                  strokeWidth={1.8}
                />
                Install & start
              </Button>
            ) : status?.running ? (
              <>
                {modelDrifted ? (
                  <Button
                    type="button"
                    size="sm"
                    className="h-7 text-[10.5px]"
                    disabled={busy}
                    onClick={() =>
                      void run("start", () => startWhisperRuntime(model))
                    }
                  >
                    <HugeiconsIcon icon={PlayIcon} size={12} strokeWidth={1.8} />
                    Switch to {MODEL_META[model].label}
                  </Button>
                ) : null}
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 text-[10.5px]"
                  disabled={busy}
                  onClick={() => void run("stop", () => stopWhisperRuntime())}
                >
                  {operation === "stop" ? (
                    <Spinner className="size-3" />
                  ) : (
                    <HugeiconsIcon
                      icon={StopCircleIcon}
                      size={12}
                      strokeWidth={1.8}
                    />
                  )}
                  Stop
                </Button>
              </>
            ) : (
              <>
                <Button
                  type="button"
                  size="sm"
                  className="h-7 text-[10.5px]"
                  disabled={busy || !status?.supported}
                  onClick={() =>
                    void run("start", () => startWhisperRuntime(model))
                  }
                >
                  {/* Starting has its own panel above, so this button is never
                      the thing reporting progress. */}
                  <HugeiconsIcon icon={PlayIcon} size={12} strokeWidth={1.8} />
                  Start
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7 text-[10.5px] text-muted-foreground"
                  disabled={busy || !status?.supported}
                  onClick={() => void installAndStart()}
                >
                  Repair
                </Button>
              </>
            )}

            {hasFilesOnDisk && !confirmUninstall ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 text-[10.5px] text-muted-foreground"
                disabled={busy}
                onClick={() => setConfirmUninstall(true)}
              >
                <HugeiconsIcon
                  icon={Delete02Icon}
                  size={12}
                  strokeWidth={1.8}
                />
                Uninstall
              </Button>
            ) : null}
          </div>
        )}

        {confirmUninstall ? (
          <div className="mt-2 flex items-center justify-between gap-2 rounded-md border border-destructive/25 bg-destructive/5 px-2.5 py-2">
            <span className="text-[10px] leading-snug text-muted-foreground">
              Remove the runtime and every downloaded model?
            </span>
            <div className="flex shrink-0 gap-1">
              <Button
                type="button"
                size="xs"
                variant="ghost"
                onClick={() => setConfirmUninstall(false)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                size="xs"
                variant="destructive"
                disabled={busy}
                onClick={() => {
                  setConfirmUninstall(false);
                  void run("uninstall", () => uninstallWhisperRuntime());
                }}
              >
                Remove files
              </Button>
            </div>
          </div>
        ) : null}

        <div className="mt-2.5 flex items-center justify-between gap-3 border-t border-border/50 pt-2.5">
          <div>
            <div className="text-[10.5px] font-medium">Start with Anbo</div>
            <div className="text-[9.5px] text-muted-foreground">
              Starts on launch when local voice input is selected.
            </div>
          </div>
          <Switch
            size="sm"
            checked={autoStart}
            onCheckedChange={(checked) => void setWhispercppAutoStart(checked)}
          />
        </div>

        {modelDrifted ? (
          <p className="mt-2 text-[10px] leading-relaxed text-amber-600 dark:text-amber-500">
            The server is still running{" "}
            {MODEL_META[runningModel as WhispercppModel]?.label ?? runningModel}
            . Dictation keeps using it until you switch.
          </p>
        ) : null}
        {status?.running && status.baseUrl ? (
          <p className="mt-2 truncate font-mono text-[9.5px] text-muted-foreground">
            PID {status.pid} / {runningModel} / {status.variant}
            {status.gpu ? " (GPU)" : ""} / {status.baseUrl}
          </p>
        ) : null}
        {status?.installDir ? (
          <p
            className="mt-1 truncate font-mono text-[9px] text-muted-foreground/75"
            title={status.installDir}
          >
            {status.installDir}
          </p>
        ) : null}
        {error ? (
          <p className="mt-2 text-[10px] leading-relaxed text-destructive">
            {error}
          </p>
        ) : null}
      </div>

      <div className="flex items-center gap-2">
        <span className="w-16 shrink-0 text-[10.5px] text-muted-foreground">
          Endpoint
        </span>
        <Input
          value={urlDraft}
          onChange={(event) => setUrlDraft(event.target.value)}
          onBlur={() => {
            const value = urlDraft.trim();
            if (value !== baseURL) void setWhispercppBaseURL(value);
          }}
          placeholder={WHISPERCPP_DEFAULT_BASE_URL}
          spellCheck={false}
          className="h-7 flex-1 font-mono text-[10.5px]"
        />
      </div>
      <p className="ml-18 text-[9.5px] leading-relaxed text-muted-foreground">
        Advanced: change this only when connecting to another local Whisper.cpp
        server.
      </p>
    </div>
  );
}
