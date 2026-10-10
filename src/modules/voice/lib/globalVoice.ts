import { invoke } from "@tauri-apps/api/core";

/** The chord held to talk; the names are the Rust enum's (`PttKey`). */
export const PUSH_TO_TALK_KEYS = [
  "win",
  "ctrl_win",
  "right_alt",
  "off",
] as const;
export type PushToTalkKey = (typeof PUSH_TO_TALK_KEYS)[number];

export function isPushToTalkKey(value: unknown): value is PushToTalkKey {
  return (
    typeof value === "string" &&
    (PUSH_TO_TALK_KEYS as readonly string[]).includes(value)
  );
}

export type PushToTalkPhase = "start" | "stop" | "cancel";

export type GlobalVoiceStatus = {
  supported: boolean;
  enabled: boolean;
  shortcut: string;
  pushToTalk: PushToTalkKey;
};

export type GlobalVoiceTarget = {
  label: string;
  windowTitle: string;
};

export type GlobalVoiceInsertResult = {
  insertedUtf16Units: number;
};

export const GLOBAL_VOICE_TOGGLE_EVENT = "anbo://global-voice-toggle";
export const GLOBAL_VOICE_PTT_EVENT = "anbo://global-voice-ptt";

export function getGlobalVoiceStatus(): Promise<GlobalVoiceStatus> {
  return invoke("global_voice_status");
}

export function setGlobalVoiceRuntimeEnabled(
  enabled: boolean,
): Promise<GlobalVoiceStatus> {
  return invoke("global_voice_set_enabled", { enabled });
}

export function setGlobalVoicePushToTalk(
  key: PushToTalkKey,
): Promise<GlobalVoiceStatus> {
  return invoke("global_voice_set_push_to_talk", { key });
}

/** Puts the orb on screen or takes it off. Unlike the window API's show,
 * showing it leaves the foreground with the app a take types into. */
export function setGlobalVoiceOrbVisible(visible: boolean): Promise<void> {
  return invoke("global_voice_show_orb", { visible });
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

/** `keepTarget` leaves the target in place for a further insert, as a
 * hands-free take does for every sentence but its last. */
export function insertGlobalVoiceText(
  text: string,
  keepTarget = false,
): Promise<GlobalVoiceInsertResult> {
  return invoke("global_voice_insert_text", { text, keepTarget });
}
