export type VoicePressState = {
  recording: boolean;
  requesting: boolean;
  transcribing: boolean;
  inserting: boolean;
  starting: boolean;
};

export type VoicePressAction = "stop" | "cancel" | "abortStart" | "start";

/**
 * Every press has to resolve to an action. Dropping the press while a start was
 * still acquiring its native target left the recorder that start went on to
 * create running until the five minute cap, with no feedback in between.
 */
export function resolveVoicePress(state: VoicePressState): VoicePressAction {
  if (state.recording) return "stop";
  if (state.requesting || state.transcribing || state.inserting) return "cancel";
  if (state.starting) return "abortStart";
  return "start";
}
