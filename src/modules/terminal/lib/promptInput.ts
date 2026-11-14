/** Who put input into a terminal: the user (keys, a paste, voice text, a pick
 *  from history, the shell input bar) or a tool or Anbo itself. */
export type TerminalInputSource = "user" | "automation";

/**
 * What stands at a shell's prompt unsubmitted, as far as the input that went
 * into the terminal tells. Terminal automation types no command into such a
 * line, and clears none the user typed (round 102).
 *
 * `chars` counts characters typed one after another at the end of the line;
 * it is the line's length only while `exact` holds, which ends with the first
 * key that moves the caret, deletes elsewhere than at the end, or brings text
 * in from history or a completion.
 */
export type PromptInput = {
  pending: boolean;
  by: TerminalInputSource | null;
  chars: number;
  exact: boolean;
};

export const EMPTY_PROMPT: PromptInput = {
  pending: false,
  by: null,
  chars: 0,
  exact: true,
};

// Keys of the user's that put text of unknown length at the prompt: Up and
// Down (history), Tab (completion), Ctrl+P, Ctrl+N, Ctrl+R, Ctrl+Y. A recalled
// command read as an empty prompt before, and a tool's command was typed onto
// the end of it.
const RECALL = /\x1b\[[0-9;]*[AB]|\x1bO[AB]|[\t\x0e\x10\x12\x19]/;
// Keys that move the caret or delete away from the end of the line.
const MOVE =
  /\x1b\[[0-9;]*[CDHF~]|\x1bO[CDHF]|[\x01\x02\x05\x06\x08\x0b\x17]|\x1b[bdf\x7f]/;
const SEQUENCES =
  /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// Shells whose Esc key empties the line.
const ESC_CLEARS = new Set(["powershell", "pwsh", "cmd"]);

/** The prompt after `data` went into the terminal, and whether a line was
 *  submitted with it. */
export function promptInputAfter(
  before: PromptInput,
  data: string,
  from: TerminalInputSource,
  shell?: string | null,
): { prompt: PromptInput; submitted: boolean } {
  let { pending, by, chars, exact } = before;
  let submitted = false;
  const empty = () => {
    pending = false;
    by = null;
    chars = 0;
    exact = true;
  };
  if (from === "user") {
    if (data === "\x1b" && ESC_CLEARS.has(shell ?? "")) {
      empty();
      return { prompt: { pending, by, chars, exact }, submitted };
    }
    if (RECALL.test(data)) {
      pending = true;
      by = "user";
      exact = false;
    } else if (pending && MOVE.test(data)) {
      exact = false;
    }
  }
  for (const character of data.replace(SEQUENCES, "")) {
    if (
      character === "\r" ||
      character === "\n" ||
      character === "\x03" ||
      character === "\x15"
    ) {
      empty();
      if (character === "\r" || character === "\n") submitted = true;
      continue;
    }
    if (character === "\x7f") {
      // Backspace at the end of a line typed straight through: the user who
      // typed three letters and took them back left an empty prompt, which
      // read as held input for ever.
      if (pending && exact && chars > 0) {
        chars -= 1;
        if (chars === 0) empty();
      }
      continue;
    }
    if (character.charCodeAt(0) >= 0x20) {
      pending = true;
      chars += 1;
      // A line the user typed into is theirs, whoever began it.
      if (from === "user" || by === null) by = from;
    }
  }
  return { prompt: { pending, by, chars, exact }, submitted };
}
