import { describe, expect, it } from "vitest";
import type { BrowserDesignCapture } from "@/modules/browser/native";
import {
  buildDesignMessage,
  describeDesignMark,
  MAX_DESIGN_MESSAGE_CHARS,
} from "./designMessage";

function capture(
  overrides: Partial<BrowserDesignCapture> = {},
): BrowserDesignCapture {
  return {
    tabId: 7,
    url: "http://localhost:5173/settings",
    title: "Settings",
    viewport: { width: 1200, height: 800, dpr: 2, scrollX: 0, scrollY: 0 },
    imagePath: "D:/proj/.anbo/artifacts/design/design-1-settings.png",
    jsonPath: "D:/proj/.anbo/artifacts/design/design-1-settings.json",
    imageBytes: 1234,
    image: null,
    marks: [
      {
        n: 1,
        kind: "box",
        note: "Too much\npadding here",
        inViewport: true,
        element: {
          tag: "button",
          name: "Save changes",
          selector: "#save",
          testId: "save",
          locator: { by: "testId", value: "save" },
        },
      },
      {
        n: 2,
        kind: "pen",
        note: "",
        inViewport: false,
      },
      {
        n: 3,
        kind: "pick",
        note: 'Rename to "Apply"',
        inViewport: true,
        element: {
          tag: "section",
          name: "Filters",
          selector: "main > section",
          locator: { by: "role", value: "region", name: "Filters" },
        },
      },
    ],
    ...overrides,
  };
}

describe("design feedback message", () => {
  it("describes each numbered mark with its note and a locator the agent can reuse", () => {
    const [box, pen, pick] = capture().marks;
    expect(describeDesignMark(box)).toBe(
      '1) area "Too much padding here" -> <button> "Save changes" [testId save]',
    );
    expect(describeDesignMark(pen)).toBe(
      "2) sketch (outside the captured viewport)",
    );
    expect(describeDesignMark(pick)).toBe(
      '3) element "Rename to \'Apply\'" -> <section> "Filters" [role region "Filters"]',
    );
  });

  it("stays on one line and names both files before the marks", () => {
    const message = buildDesignMessage(capture(), "Keep the\nbrand colors.");
    expect(message).not.toMatch(/[\r\n]/);
    expect(
      message.startsWith(
        "Design feedback from Anbo on http://localhost:5173/settings",
      ),
    ).toBe(true);
    expect(message.indexOf(".png")).toBeLessThan(message.indexOf(".json"));
    expect(message.indexOf(".json")).toBeLessThan(message.indexOf("Marks:"));
    expect(message).toContain("1) area");
    expect(message).toContain("2) sketch");
    expect(message).toContain("3) element");
    expect(message.endsWith("From the user: Keep the brand colors.")).toBe(
      true,
    );
  });

  it("keeps the whole message under the agent limit and says what was left out", () => {
    const marks = Array.from({ length: 200 }, (_, index) => ({
      n: index + 1,
      kind: "box",
      note: "x".repeat(200),
      inViewport: true,
      element: { tag: "div", name: "y".repeat(50), selector: "#z" },
    }));
    const message = buildDesignMessage(capture({ marks }), "");
    expect(message.length).toBeLessThanOrEqual(MAX_DESIGN_MESSAGE_CHARS);
    expect(message).toMatch(/\(\+\d+ more in the JSON\)\.$/);
    expect(message).toContain("1) area");
  });

  it("strips control characters and tolerates missing fields", () => {
    const message = buildDesignMessage(
      capture({
        title: null,
        marks: [{ n: 1, kind: "arrow", note: "bad\u0007note", element: null }],
      }),
      "",
    );
    expect(message).toContain('1) arrow "bad note"');
    expect(message).not.toContain('("');
    expect(message).toContain("settings, 1 mark.");
  });
});
