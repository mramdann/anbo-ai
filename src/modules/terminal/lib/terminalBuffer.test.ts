import { describe, expect, it } from "vitest";
import { classifyAgentScreen } from "@/modules/agents/lib/agentScreenClassifier";
import { joinTerminalBufferRows, releasedTerminalText } from "./terminalBuffer";

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
