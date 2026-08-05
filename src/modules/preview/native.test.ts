import { describe, expect, it } from "vitest";
import {
  isSelfReferenceUrl,
  isSupportedBrowserUrl,
  toPhysicalBounds,
} from "./native";

describe("native preview URL policy", () => {
  it("allows HTTP(S) and rejects active or local content schemes", () => {
    expect(isSupportedBrowserUrl("http://localhost:3000")).toBe(true);
    expect(isSupportedBrowserUrl("https://example.com/path")).toBe(true);
    expect(isSupportedBrowserUrl("javascript:alert(1)")).toBe(false);
    expect(isSupportedBrowserUrl("data:text/html,hello")).toBe(false);
    expect(isSupportedBrowserUrl("file:///tmp/report.html")).toBe(false);
  });

  it("blocks the app from loading its own development origin", () => {
    expect(
      isSelfReferenceUrl(
        "http://localhost:1420/inside",
        "http://localhost:1420/app",
      ),
    ).toBe(true);
    expect(
      isSelfReferenceUrl("http://localhost:5173", "http://localhost:1420/app"),
    ).toBe(false);
  });
});

describe("native preview bounds", () => {
  it("converts viewport CSS pixels to rounded physical pixels", () => {
    const rect = {
      left: 10.25,
      top: 20.5,
      width: 300.25,
      height: 200.75,
    } as DOMRect;
    expect(toPhysicalBounds(rect, 1.5)).toEqual({
      x: 15,
      y: 31,
      width: 450,
      height: 301,
    });
  });
});
