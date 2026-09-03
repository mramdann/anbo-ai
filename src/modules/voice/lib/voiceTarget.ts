export type VoiceInsertResult = { ok: true } | { ok: false; message: string };

export type VoiceTargetKind =
  | "dom"
  | "terminal"
  | "editor"
  | "browser"
  | "blocked";

export type VoiceTarget = {
  kind: VoiceTargetKind;
  label: string;
  insert: (text: string) => VoiceInsertResult | Promise<VoiceInsertResult>;
};

export const VOICE_TEXT_LIMIT = 8_000;

export function normalizeVoiceText(value: string): string {
  return value
    .replace(/[\r\n\u2028\u2029]+/g, " ")
    .replace(/[\t\f\v ]+/g, " ")
    .trim()
    .slice(0, VOICE_TEXT_LIMIT);
}

export function failedVoiceInsert(message: string): VoiceInsertResult {
  return { ok: false, message };
}

export function successfulVoiceInsert(): VoiceInsertResult {
  return { ok: true };
}
