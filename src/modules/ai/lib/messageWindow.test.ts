import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import {
  activeRunMessages,
  visibleMessageWindow,
} from "./messageWindow";

function message(id: string, role: UIMessage["role"]): UIMessage {
  return { id, role, parts: [] };
}

describe("visibleMessageWindow", () => {
  it("keeps only the newest requested messages", () => {
    const result = visibleMessageWindow([1, 2, 3, 4, 5], 2);
    expect(result).toEqual({ hiddenCount: 3, visible: [4, 5] });
  });

  it("keeps short conversations intact", () => {
    const messages = [1, 2];
    expect(visibleMessageWindow(messages, 40)).toEqual({
      hiddenCount: 0,
      visible: messages,
    });
  });
});

describe("activeRunMessages", () => {
  it("starts at the newest user turn", () => {
    const messages = [
      message("u1", "user"),
      message("a1", "assistant"),
      message("u2", "user"),
      message("a2", "assistant"),
    ];
    expect(activeRunMessages(messages).map((item) => item.id)).toEqual([
      "u2",
      "a2",
    ]);
  });

  it("bounds malformed histories without a user turn", () => {
    const messages = [
      message("a1", "assistant"),
      message("a2", "assistant"),
      message("a3", "assistant"),
    ];
    expect(activeRunMessages(messages).map((item) => item.id)).toEqual([
      "a2",
      "a3",
    ]);
  });
});
