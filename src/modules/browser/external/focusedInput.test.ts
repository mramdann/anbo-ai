import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const script = readFileSync(
  "src-tauri/src/modules/browser/focusedInput.js",
  "utf8",
);
class Frame {
  constructor(public contentDocument: { activeElement: unknown } | null) {}
}
const inspect = (element: unknown) =>
  runInNewContext(script, {
    document: { activeElement: element },
    HTMLIFrameElement: Frame,
  });

describe("shared browser dictation guard", () => {
  it("refuses passwords, readonly inputs and inaccessible frames", () => {
    expect(inspect({ tagName: "INPUT", type: "password" })).toBe("password");
    expect(inspect({ tagName: "INPUT", type: "text", readOnly: true })).toBe(
      "none",
    );
    expect(inspect(new Frame(null))).toBe("frame");
    expect(inspect(null)).toBe("none");
  });
  it("resolves an editable shadow input without changing focus", () => {
    expect(
      inspect({ shadowRoot: { activeElement: { tagName: "TEXTAREA" } } }),
    ).toBe("editable");
    expect(
      inspect(new Frame({ activeElement: { tagName: "INPUT", type: "text" } })),
    ).toBe("editable");
  });
});
