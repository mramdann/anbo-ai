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
 *
 * `unsettled`: the user sent the line with Enter and the shell has not said
 * what became of it. A shell that marks a command's start (OSC 133 C) does so
 * the moment a line is complete; until it does, the line is still being
 * written: a block whose closing brace is to come (the shell shows `>>`),
 * lines pasted ahead of their Enter, an Enter that only took a completion.
 * Such a line read as an empty prompt before, and a tool's command would have
 * been typed into the middle of it (round 103).
 */
export type PromptInput = {
  pending: boolean;
  by: TerminalInputSource | null;
  chars: number;
  exact: boolean;
  unsettled: boolean;
};

export const EMPTY_PROMPT: PromptInput = {
  pending: false,
  by: null,
  chars: 0,
  exact: true,
  unsettled: false,
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

/**
 * The prompt after `data` went into the terminal, and whether a line was
 * submitted with it. `settles`: the terminal is at its shell's prompt and the
 * shell marks a command's start, so it will say what became of a line sent
 * now (see `unsettled`).
 */
export function promptInputAfter(
  before: PromptInput,
  data: string,
  from: TerminalInputSource,
  shell?: string | null,
  settles = false,
): { prompt: PromptInput; submitted: boolean } {
  let { pending, by, chars, exact, unsettled } = before;
  let submitted = false;
  const empty = () => {
    pending = false;
    by = null;
    chars = 0;
    exact = true;
    unsettled = false;
  };
  const now = () => ({ pending, by, chars, exact, unsettled });
  if (from === "user") {
    if (data === "\x1b" && ESC_CLEARS.has(shell ?? "")) {
      empty();
      return { prompt: now(), submitted };
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
    if (character === "\r" || character === "\n") {
      submitted = true;
      if (from === "user" && settles && pending) {
        // Theirs until the shell marks the command's start or draws a new
        // prompt; how much of it stands there is not known.
        by = "user";
        chars = 0;
        exact = false;
        unsettled = true;
      } else {
        empty();
      }
      continue;
    }
    if (character === "\x03") {
      empty();
      continue;
    }
    if (character === "\x15") {
      // Ctrl+U takes the line the caret is on, not the lines sent before it.
      if (!unsettled) empty();
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
  return { prompt: now(), submitted };
}
