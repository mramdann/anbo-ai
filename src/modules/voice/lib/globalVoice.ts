import { invoke } from "@tauri-apps/api/core";

export type GlobalVoiceStatus = {
  supported: boolean;
  enabled: boolean;
  shortcut: string;
};

export type GlobalVoiceTarget = {
  label: string;
  windowTitle: string;
};

export type GlobalVoiceInsertResult = {
  insertedUtf16Units: number;
};

export const GLOBAL_VOICE_TOGGLE_EVENT = "anbo://global-voice-toggle";

export function getGlobalVoiceStatus(): Promise<GlobalVoiceStatus> {
  return invoke("global_voice_status");
}

export function setGlobalVoiceRuntimeEnabled(
  enabled: boolean,
): Promise<GlobalVoiceStatus> {
  return invoke("global_voice_set_enabled", { enabled });
}

export function captureGlobalVoiceTarget(): Promise<GlobalVoiceTarget> {
  return invoke("global_voice_capture_target");
}

export function clearGlobalVoiceTarget(): Promise<void> {
  return invoke("global_voice_clear_target");
}

export function rememberGlobalVoiceForeground(): Promise<void> {
  return invoke("global_voice_remember_foreground");
}

export function insertGlobalVoiceText(
  text: string,
): Promise<GlobalVoiceInsertResult> {
  return invoke("global_voice_insert_text", { text });
}
