import { describe, expect, it, vi } from "vitest";
import {
  ctrlVPasteAction,
  pasteIntoTerminal,
  textPasteAction,
} from "./terminalPaste";

describe("pasteIntoTerminal", () => {
  it("pastes and focuses the resolved terminal", () => {
    const terminal = { paste: vi.fn(), focus: vi.fn() };

    expect(pasteIntoTerminal(terminal, "/repo/file.ts ")).toBe(true);
    expect(terminal.paste).toHaveBeenCalledWith("/repo/file.ts ");
    expect(terminal.focus).toHaveBeenCalledOnce();
  });

  it("returns false when no terminal is resolved", () => {
    expect(pasteIntoTerminal(null, "/repo/file.ts ")).toBe(false);
  });
});

describe("Ctrl+V on Windows", () => {
  it("pastes the text as one bracketed paste into a program that asked for it", () => {
    expect(ctrlVPasteAction("a\nb\n", true)).toEqual({
      kind: "paste",
      text: "a\nb\n",
    });
  });

  it("sends the key on without text, so an agent can paste the image", () => {
    expect(ctrlVPasteAction(null, true)).toEqual({ kind: "key" });
    expect(ctrlVPasteAction(null, false)).toEqual({ kind: "key" });
    expect(ctrlVPasteAction("", true)).toEqual({ kind: "none" });
  });

  it("types one line in at a plain prompt, without the newline that would run it", () => {
    expect(ctrlVPasteAction("git status\r\n", false)).toEqual({
      kind: "paste",
      text: "git status",
    });
    expect(ctrlVPasteAction("\n", false)).toEqual({ kind: "none" });
  });

  it("leaves several lines to the program's own paste at a plain prompt", () => {
    // PSReadLine pastes them as one input instead of running each line.
    expect(ctrlVPasteAction("cd x\nnpm test", false)).toEqual({ kind: "key" });
    expect(ctrlVPasteAction("cd x\r\nnpm test\r\n", false)).toEqual({
      kind: "key",
    });
  });

  it("pastes the text as it is for Ctrl+Shift+V", () => {
    expect(textPasteAction("a\nb")).toEqual({ kind: "paste", text: "a\nb" });
    expect(textPasteAction(null)).toEqual({ kind: "none" });
    expect(textPasteAction("")).toEqual({ kind: "none" });
  });
});
