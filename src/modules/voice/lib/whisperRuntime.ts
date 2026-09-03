import type { WhispercppModel } from "@/modules/ai/config";
import { invoke } from "@tauri-apps/api/core";

export const WHISPER_RUNTIME_PROGRESS_EVENT =
  "anbo:whisper-runtime-progress" as const;

export type WhisperRuntimePhase =
  | "notInstalled"
  | "installing"
  | "stopped"
  | "running";

export type WhisperInstallProgress = {
  phase: "runtime" | "model" | "finalizing";
  model: WhispercppModel;
  downloaded: number;
  total: number;
};

export type WhisperRuntimeStatus = {
  supported: boolean;
  phase: WhisperRuntimePhase;
  installed: boolean;
  running: boolean;
  installing: boolean;
  model: WhispercppModel | null;
  installedModels: WhispercppModel[];
  baseUrl: string | null;
  pid: number | null;
  installDir: string;
  sizeBytes: number;
  progress: WhisperInstallProgress | null;
  error: string | null;
};

export function getWhisperRuntimeStatus(): Promise<WhisperRuntimeStatus> {
  return invoke("whisper_runtime_status");
}

export function installWhisperRuntime(
  model: WhispercppModel,
): Promise<WhisperRuntimeStatus> {
  return invoke("whisper_runtime_install", { model });
}

export function cancelWhisperRuntimeInstall(): Promise<boolean> {
  return invoke("whisper_runtime_cancel_install");
}

export function startWhisperRuntime(
  model: WhispercppModel,
): Promise<WhisperRuntimeStatus> {
  return invoke("whisper_runtime_start", { model });
}

export function stopWhisperRuntime(): Promise<WhisperRuntimeStatus> {
  return invoke("whisper_runtime_stop");
}

export function uninstallWhisperRuntime(): Promise<WhisperRuntimeStatus> {
  return invoke("whisper_runtime_uninstall");
}

export function formatRuntimeBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  const mebibytes = bytes / (1024 * 1024);
  if (mebibytes < 1024) return `${mebibytes.toFixed(1)} MB`;
  return `${(mebibytes / 1024).toFixed(2)} GB`;
}
