import { describe, expect, it } from "vitest";
import {
  browserPresentationBounds,
  browserUrlError,
  canMeasureBrowserPane,
  createBrowserOwnerId,
  forgetBrowserOwnerId,
  isSelfReferenceUrl,
  isSupportedBrowserUrl,
  shouldShowBrowserPane,
  toPhysicalBounds,
} from "./native";

describe("native browser URL policy", () => {
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

  it("derives validation errors from the current URL", () => {
    const appUrl = "http://localhost:1420/app";
    expect(browserUrlError("", appUrl)).toBeNull();
    expect(
      browserUrlError("https://www.youtube.com/watch?v=1", appUrl),
    ).toBeNull();
    expect(browserUrlError("about:blank", appUrl)).toBe(
      "Only HTTP(S) URLs can load in the browser.",
    );
    expect(browserUrlError("http://localhost:1420/inside", appUrl)).toBe(
      "Anbo cannot be opened inside its own browser pane.",
    );
  });
});

describe("native browser bounds", () => {
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
      width: 451,
      height: 301,
    });
  });

  it("measures hidden workspace panes without showing their native surface", () => {
    const canMeasure = canMeasureBrowserPane(true, true, true);

    expect(canMeasure).toBe(true);
    expect(shouldShowBrowserPane(canMeasure, false, true, false)).toBe(false);
    expect(shouldShowBrowserPane(canMeasure, true, true, false)).toBe(true);
  });

  it("retains visible geometry when a browser moves to a background host", () => {
    const measured = { x: 0, y: 20, width: 1000, height: 700 };
    const lastVisible = { x: 0, y: 52, width: 1000, height: 668 };

    expect(browserPresentationBounds(false, measured, lastVisible)).toBe(
      lastVisible,
    );
    expect(browserPresentationBounds(true, measured, lastVisible)).toBe(
      measured,
    );
    expect(browserPresentationBounds(false, measured, null)).toBe(measured);
  });
});

describe("native browser ownership", () => {
  it("keeps one owner token per tab across workspace host handoffs", () => {
    const first = createBrowserOwnerId(17);
    const other = createBrowserOwnerId(18);
    expect(first).toBe(createBrowserOwnerId(17));
    expect(first).not.toBe(other);
    forgetBrowserOwnerId(17, first);
    const replacement = createBrowserOwnerId(17);
    expect(replacement).not.toBe(first);
    forgetBrowserOwnerId(17, replacement);
    forgetBrowserOwnerId(18, other);
  });
});
