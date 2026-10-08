export type TerminalPasteTarget = {
  paste: (text: string) => void;
  focus: () => void;
};

export function pasteIntoTerminal(
  terminal: TerminalPasteTarget | null,
  text: string,
): boolean {
  if (!terminal) return false;
  terminal.paste(text);
  terminal.focus();
  return true;
}

/** `paste` goes through xterm, bracketed when the program asked for it;
 * `key` sends Ctrl+V (^V) on to the program. */
export type TerminalPasteAction =
  | { kind: "paste"; text: string }
  | { kind: "key" }
  | { kind: "none" };

/** Ctrl+V on Windows, given the clipboard's text (null: none, such as an
 * image). A program that asked for bracketed paste (Claude Code, Codex, bash)
 * gets the text as one paste, and with no text it gets the key, which those
 * agents read as "paste the image". At a prompt without bracketed paste
 * (Windows PowerShell's PSReadLine, cmd) one line is typed in, without a
 * trailing newline that would run it, and several lines go to the program's
 * own Ctrl+V, which PSReadLine pastes without running them line by line. */
export function ctrlVPasteAction(
  text: string | null,
  bracketed: boolean,
): TerminalPasteAction {
  if (text === null) return { kind: "key" };
  if (!text) return { kind: "none" };
  if (bracketed) return { kind: "paste", text };
  const line = text.replace(/\r?\n$/, "");
  if (/[\r\n]/.test(line)) return { kind: "key" };
  return line ? { kind: "paste", text: line } : { kind: "none" };
}

/** Ctrl+Shift+V, or a context-menu paste read again: always the text. */
export function textPasteAction(text: string | null): TerminalPasteAction {
  return text ? { kind: "paste", text } : { kind: "none" };
}
