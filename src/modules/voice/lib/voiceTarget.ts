export type VoiceInsertResult = { ok: true } | { ok: false; message: string };

type VoiceTargetKind =
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

/**
 * What to type after `previous` in the same take, or `next` alone for the
 * first text. Sentences of a hands-free take are transcribed one by one, and
 * Whisper does not know that the one before it ended: "...first one. and
 * this is", so a sentence after a full stop starts with a capital.
 */
export function joinVoiceText(previous: string | null, next: string): string {
  if (previous === null || !next) return next;
  const capital = /[.!?…]["'”’)\]]*$/u.test(previous)
    ? next.charAt(0).toLocaleUpperCase() + next.slice(1)
    : next;
  return ` ${capital}`;
}

export function failedVoiceInsert(message: string): VoiceInsertResult {
  return { ok: false, message };
}

export function successfulVoiceInsert(): VoiceInsertResult {
  return { ok: true };
}
