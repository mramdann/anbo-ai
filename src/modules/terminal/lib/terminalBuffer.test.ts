import { describe, expect, it } from "vitest";
import { classifyAgentScreen } from "@/modules/agents/lib/agentScreenClassifier";
import { joinTerminalBufferRows } from "./terminalBuffer";

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
