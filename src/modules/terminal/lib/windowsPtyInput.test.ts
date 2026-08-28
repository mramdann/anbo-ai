import { describe, expect, it } from "vitest";
import { encodeWindowsPtyInput } from "./windowsPtyInput";

describe("Windows PTY input encoding", () => {
  it("leaves ASCII and terminal control sequences untouched", () => {
    const input = "Write-Output ok\r\x1b[A";
    expect(encodeWindowsPtyInput(input)).toBe(input);
  });

  it("encodes BMP Unicode as Win32 key down and key up events", () => {
    expect(encodeWindowsPtyInput("A\u2713B")).toBe(
      "A\x1b[0;0;10003;1;0;1_\x1b[0;0;10003;0;0;1_B",
    );
  });

  it("preserves supplementary characters as paired UTF-16 events", () => {
    expect(encodeWindowsPtyInput("\u{1f600}")).toBe(
      "\x1b[0;0;55357;1;0;1_\x1b[0;0;55357;0;0;1_" +
        "\x1b[0;0;56832;1;0;1_\x1b[0;0;56832;0;0;1_",
    );
  });
});
