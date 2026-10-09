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
export const GLOBAL_VOICE_CAPTION_EVENT = "anbo://global-voice-caption";

/** The live text bubble beside the orb, as the shell last placed it. */
export type GlobalVoiceCaption = {
  /** Grows with every change; the larger one is the newer. */
  seq: number;
  text: string | null;
  /** The bubble sits above the orb rather than below it. */
  above: boolean;
  /** The bubble lines up with the orb's right edge rather than its left. */
  alignRight: boolean;
};

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

/** Shows `text` in the bubble beside the orb, or hides the bubble for null. */
function showGlobalVoiceCaption(text: string | null): Promise<void> {
  return invoke("global_voice_caption", { text });
}

/** undefined while nothing waits; null is a hide. */
let wantedCaption: string | null | undefined;
let applyingCaption = false;

/**
 * Shows `text` beside the orb, or hides the bubble for null. The command is
 * async, so two calls in flight can land in either order, and a hide that
 * overtook the last words would leave the bubble on screen. Calls go one at
 * a time, and of those waiting only the newest is sent.
 */
export async function applyGlobalVoiceCaption(
  text: string | null,
  onError: (error: unknown, text: string | null) => void,
): Promise<void> {
  wantedCaption = text;
  if (applyingCaption) return;
  applyingCaption = true;
  try {
    while (wantedCaption !== undefined) {
      const next = wantedCaption;
      wantedCaption = undefined;
      await showGlobalVoiceCaption(next).catch((error) => onError(error, next));
    }
  } finally {
    applyingCaption = false;
  }
}

export function readGlobalVoiceCaption(): Promise<GlobalVoiceCaption> {
  return invoke("global_voice_caption_current");
}
