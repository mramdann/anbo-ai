import { describe, expect, it } from "vitest";
import {
  EMPTY_PROMPT,
  type PromptInput,
  promptInputAfter,
  type TerminalInputSource,
} from "./promptInput";

type Step = [data: string, from?: TerminalInputSource];

function promptAfter(steps: Step[], shell = "powershell"): PromptInput {
  let prompt = EMPTY_PROMPT;
  for (const [data, from = "user"] of steps) {
    prompt = promptInputAfter(prompt, data, from, shell).prompt;
  }
  return prompt;
}

describe("promptInputAfter", () => {
  it("knows who typed the line that stands at the prompt", () => {
    expect(promptAfter([["g"], ["i"], ["t"]])).toMatchObject({
      pending: true,
      by: "user",
      chars: 3,
    });
    expect(promptAfter([["echo staged", "automation"]])).toMatchObject({
      pending: true,
      by: "automation",
    });
    // A line the user typed into is theirs, whoever began it.
    expect(promptAfter([["echo staged", "automation"], ["!"]])).toMatchObject({
      pending: true,
      by: "user",
    });
    expect(promptAfter([["git"], [" status", "automation"]])).toMatchObject({
      by: "user",
    });
  });

  it("is empty again after Enter, Ctrl+C, Ctrl+U, and Esc in a Windows shell", () => {
    for (const end of ["\r", "\n", "\x03", "\x15", "\x1b"]) {
      expect(promptAfter([["git status"], [end]])).toEqual(EMPTY_PROMPT);
    }
    // A line that went to the shell, on every way in (round 93: the
    // terminal's buffer is held from then until the command's start mark).
    expect(
      promptInputAfter(EMPTY_PROMPT, "node -v\r", "automation").submitted,
    ).toBe(true);
    expect(promptInputAfter(EMPTY_PROMPT, "\r", "user").submitted).toBe(true);
    expect(promptInputAfter(EMPTY_PROMPT, "a\nb", "user").submitted).toBe(true);
    expect(promptInputAfter(EMPTY_PROMPT, "ab", "user").submitted).toBe(false);
    expect(promptInputAfter(EMPTY_PROMPT, "x\x03", "user").submitted).toBe(
      false,
    );
    // In bash Esc only begins a key sequence.
    expect(promptAfter([["git status"], ["\x1b"]], "bash").pending).toBe(true);
  });

  it("is empty again once the user took back what they typed", () => {
    expect(promptAfter([["a"], ["b"], ["\x7f"], ["\x7f"]])).toEqual(EMPTY_PROMPT);
    expect(promptAfter([["a"], ["b"], ["\x7f"]])).toMatchObject({
      pending: true,
      chars: 1,
    });
    // More Backspaces than letters change nothing.
    expect(promptAfter([["\x7f"], ["\x7f"]])).toEqual(EMPTY_PROMPT);
    // A tool's staged text the user took back is gone too.
    expect(promptAfter([["ab", "automation"], ["\x7f"], ["\x7f"]])).toEqual(
      EMPTY_PROMPT,
    );
  });

  it("stays held when the count cannot be trusted any more", () => {
    // Left, then Backspace: one of the two letters is still there.
    expect(promptAfter([["a"], ["b"], ["\x1b[D"], ["\x7f"], ["\x7f"]])).toMatchObject(
      { pending: true, by: "user", exact: false },
    );
    // Ctrl+Backspace takes a whole word, Home moves the caret.
    for (const key of ["\x08", "\x1b[H", "\x1bOH", "\x1b[1;5D", "\x1b[3~"]) {
      expect(
        promptAfter([["ab cd"], [key], ["\x7f"], ["\x7f"], ["\x7f"], ["\x7f"], ["\x7f"]])
          .pending,
      ).toBe(true);
    }
  });

  it("holds a command the user brought back from history or a completion", () => {
    // Round 102: Up at an empty prompt put the last command there, the
    // prompt read as empty, and a tool's command went onto its end.
    for (const key of ["\x1b[A", "\x1b[B", "\x1bOA", "\t", "\x10", "\x12"]) {
      expect(promptAfter([[key]])).toMatchObject({
        pending: true,
        by: "user",
        exact: false,
      });
    }
    expect(promptAfter([["\x1b[A"], ["\r"]])).toEqual(EMPTY_PROMPT);
    // Backspaces do not empty a line of unknown length.
    expect(promptAfter([["\x1b[A"], ["\x7f"], ["\x7f"]]).pending).toBe(true);
    // The same keys from a tool are no history pick of the user's.
    expect(promptAfter([["\x1b[A", "automation"]])).toEqual(EMPTY_PROMPT);
  });

  it("keeps a line the user sent until the shell says what became of it", () => {
    // At the prompt of a shell that marks a command's start (`settles`).
    const settling = (steps: Step[], shell = "powershell"): PromptInput => {
      let prompt = EMPTY_PROMPT;
      for (const [data, from = "user"] of steps) {
        prompt = promptInputAfter(prompt, data, from, shell, true).prompt;
      }
      return prompt;
    };
    const theirs = { pending: true, by: "user", exact: false, unsettled: true };
    // A block whose closing brace is to come: the shell shows `>>`, marks no
    // start, and the line read as an empty prompt.
    expect(settling([["foreach ($x in 1..3) {"], ["\r"]])).toMatchObject(theirs);
    // Its next lines, each sent with Enter, and Backspaces in them.
    expect(
      settling([["foreach ($x in 1..3) {"], ["\r"], ["  $x"], ["\r"], ["\x7f"], ["\x7f"]]),
    ).toMatchObject(theirs);
    // Lines pasted ahead of their Enter.
    expect(
      settling([["\x1b[200~if ($true) {\r\n  1\r\n}\x1b[201~"]]),
    ).toMatchObject(theirs);
    // A command brought back from history and sent.
    expect(settling([["\x1b[A"], ["\r"]])).toMatchObject(theirs);
    // The user's Enter on text a tool staged makes it theirs.
    expect(settling([["echo staged", "automation"], ["\r"]])).toMatchObject(theirs);
    // Ctrl+U takes the line the caret is on; Ctrl+C and Esc take all of it.
    expect(settling([["a {"], ["\r"], ["b"], ["\x15"]])).toMatchObject(theirs);
    expect(settling([["a {"], ["\r"], ["\x03"]])).toEqual(EMPTY_PROMPT);
    expect(settling([["a {"], ["\r"], ["\x1b"]])).toEqual(EMPTY_PROMPT);
    // Enter at an empty prompt sends nothing to wait for.
    expect(settling([["\r"]])).toEqual(EMPTY_PROMPT);
    // A tool follows its own command itself (terminal_execute).
    expect(settling([["node -v\r", "automation"]])).toEqual(EMPTY_PROMPT);
    // The terminal's buffer is held for the start mark as before.
    expect(
      promptInputAfter(EMPTY_PROMPT, "git status\r", "user", "powershell", true)
        .submitted,
    ).toBe(true);
    // Where no start mark is to come (cmd, a program that reads the line),
    // Enter empties the prompt as before.
    expect(promptAfter([["git status"], ["\r"]])).toEqual(EMPTY_PROMPT);
    expect(
      promptInputAfter(EMPTY_PROMPT, "yes\r", "user", "powershell", false).prompt,
    ).toEqual(EMPTY_PROMPT);
  });

  it("ignores what a terminal answers by itself", () => {
    // Focus reports, a cursor position report, device attributes, a Win32
    // key event, an OSC answer.
    for (const report of [
      "\x1b[I",
      "\x1b[O",
      "\x1b[12;40R",
      "\x1b[?1;2c",
      "\x1b[0;0;233;1;0;1_",
      "\x1b]11;rgb:0000/0000/0000\x07",
    ]) {
      expect(promptAfter([[report]])).toEqual(EMPTY_PROMPT);
    }
  });
});
