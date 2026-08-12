import { afterEach, describe, expect, it, vi } from "vitest";
import {
  browserAutomationActivityFromPayload,
  clearBrowserAutomationActivity,
  getBrowserAutomationActivity,
  markBrowserAutomationActivity,
} from "./automationActivity";

describe("browser automation activity", () => {
  afterEach(() => {
    clearBrowserAutomationActivity(7);
    vi.useRealTimers();
  });

  it("accepts only events that target a browser tab", () => {
    expect(
      browserAutomationActivityFromPayload({
        method: "click",
        params: { tabId: 7 },
      }),
    ).toEqual({ method: "click", tabId: 7 });
    expect(
      browserAutomationActivityFromPayload({
        method: "list_tabs",
        params: {},
      }),
    ).toBeNull();
    expect(browserAutomationActivityFromPayload(null)).toBeNull();
  });

  it("extends activity on every action and clears it after inactivity", () => {
    vi.useFakeTimers();
    markBrowserAutomationActivity(7, "navigate", 1_000);
    expect(getBrowserAutomationActivity(7)).toBe("navigate");

    vi.advanceTimersByTime(750);
    markBrowserAutomationActivity(7, "snapshot", 1_000);
    vi.advanceTimersByTime(750);
    expect(getBrowserAutomationActivity(7)).toBe("snapshot");

    vi.advanceTimersByTime(250);
    expect(getBrowserAutomationActivity(7)).toBeNull();
  });
});
