import { describe, expect, it } from "vitest";
import { classifyAgentScreen } from "@/modules/agents/lib/agentScreenClassifier";
import { OutputTracker } from "@/modules/agents/lib/outputTracker";
import {
  joinTerminalBufferRows,
  releasedTerminalText,
  rowWithoutBlanksAfterCaret,
} from "./terminalBuffer";

describe("joinTerminalBufferRows", () => {
  it("joins visual wraps without inventing logical newlines", () => {
    expect(
      joinTerminalBufferRows(
        [
          { text: "Brewed for ", wrapped: false },
          { text: "12s", wrapped: true },
          { text: ">", wrapped: false },
        ],
        20,
      ),
    ).toBe("Brewed for 12s\n>");
  });

  it("bounds logical lines and removes only trailing empty rows", () => {
    expect(
      joinTerminalBufferRows(
        [
          { text: "old", wrapped: false },
          { text: "new", wrapped: false },
          { text: " output", wrapped: true },
          { text: "", wrapped: false },
        ],
        1,
      ),
    ).toBe("new output");
  });

  it("keeps a wrapped Claude completion visible to the status classifier", () => {
    const screen = joinTerminalBufferRows(
      [
        { text: "Claude Code\nThought for 5s\nBrewed for ", wrapped: false },
        { text: "5s", wrapped: true },
        { text: "\n>\nmanual mode on ? for shortcuts", wrapped: false },
      ],
      20,
    );
    expect(classifyAgentScreen("claude", screen)).toBe("ready");
  });
});

describe("releasedTerminalText", () => {
  const prompt = "PS D:\work> ";

  it("puts the output that came since the buffer was let go after it", () => {
    // Round 102: a hidden terminal was let go with a half-typed line at its
    // prompt; the Ctrl+C that cleared it came after, and every read went on
    // showing the half line.
    expect(
      releasedTerminalText(
        `${prompt}echo one\r\none\r\n${prompt}node -e "half`,
        `^C\r\n${prompt}`,
        20,
      ),
    ).toBe(`${prompt}echo one\none\n${prompt}node -e "half^C\n${prompt}`);
  });

  it("reads a buffer let go and one never bound as before", () => {
    expect(releasedTerminalText(`${prompt}echo one\r\none`, "", 20)).toBe(
      `${prompt}echo one\none`,
    );
    expect(releasedTerminalText(null, "one\r\ntwo\r\n", 20)).toBe("one\ntwo");
    expect(releasedTerminalText(null, "", 20)).toBe("");
  });

  it("drops escape sequences and keeps the latest lines", () => {
    expect(
      releasedTerminalText(
        "\x1b[32mold\x1b[0m\r\nkept\x1b[5;1H",
        "\x1b]0;title\x07 more\r\nlast\r\n\r\n",
        2,
      ),
    ).toBe("kept more\nlast");
  });
});

describe("rowWithoutBlanksAfterCaret", () => {
  const prompt = "PS D:\\work> ";

  it("drops the blanks a shell wrote over a line the user took back", () => {
    // "git stat" typed and taken back with eight Backspaces: the caret is
    // back after the prompt, and the row ends in eight written spaces.
    expect(rowWithoutBlanksAfterCaret(`${prompt}        `, prompt.length)).toBe(
      prompt,
    );
    // The prompt's own space, left of the caret, stays.
    expect(rowWithoutBlanksAfterCaret(prompt, prompt.length)).toBe(prompt);
    // So does text to the right of the caret, and a blank inside it.
    expect(
      rowWithoutBlanksAfterCaret(`${prompt}git  status   `, prompt.length + 3),
    ).toBe(`${prompt}git  status`);
    // Blanks the user typed, left of the caret, are theirs.
    expect(
      rowWithoutBlanksAfterCaret(`${prompt}echo   `, prompt.length + 7),
    ).toBe(`${prompt}echo   `);
    expect(rowWithoutBlanksAfterCaret("", 0)).toBe("");
  });

  it("lets the next command read as going on from the prompt", () => {
    // Round 103: with the blanks kept, the prompt read as a line rewritten
    // once a tool's command was typed over them, and the command's output
    // came back with a line break and the prompt in front of it.
    const after = `one\n${prompt}echo ok\nok\n${prompt}`;
    const clean = new OutputTracker("t1", 4);
    const cursor = clean.checkpoint(
      "a",
      `one\n${rowWithoutBlanksAfterCaret(`${prompt}        `, prompt.length)}`,
    );
    expect(clean.span("a", after, cursor).text).toBe(
      `echo ok\nok\n${prompt}`,
    );
    // As it read before: the row as the terminal holds it.
    const kept = new OutputTracker("t1", 4);
    const old = kept.checkpoint("a", `one\n${prompt}        `);
    expect(kept.span("a", after, old).text).toBe(
      `\n${prompt}echo ok\nok\n${prompt}`,
    );
  });
});
