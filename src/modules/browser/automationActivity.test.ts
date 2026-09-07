import { afterEach, describe, expect, it, vi } from "vitest";
import { listen } from "@tauri-apps/api/event";
import {
  browserAutomationActivityFromPayload,
  clearBrowserAutomationActivity,
  ensureBrowserAutomationActivityListener,
  getBrowserAutomationActivity,
  getBrowserAutomationState,
  markBrowserAutomationActivity,
  receiveBrowserAutomationActivity,
} from "./automationActivity";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

describe("browser automation activity", () => {
  it("retains a session through thinking gaps and ignores late work after an explicit end", () => {
    vi.useFakeTimers();
    const event = {
      tabId: 7,
      requestId: 1,
      controlId: 1,
      sequence: 1,
      method: "find",
      phase: "done",
      actor: { brand: "codex" },
    };
    receiveBrowserAutomationActivity(event);
    vi.advanceTimersByTime(600_000);
    expect(getBrowserAutomationActivity(7)).toBe("find");
    expect(vi.getTimerCount()).toBe(0);
    receiveBrowserAutomationActivity({
      ...event,
      sequence: 2,
      phase: "ended",
      controlId: 2,
    });
    expect(getBrowserAutomationActivity(7)).toBe("find");
    receiveBrowserAutomationActivity({ ...event, sequence: 3, phase: "ended" });
    expect(getBrowserAutomationActivity(7)).toBeNull();
    receiveBrowserAutomationActivity({ ...event, sequence: 4 });
    expect(getBrowserAutomationActivity(7)).toBeNull();
    receiveBrowserAutomationActivity({
      ...event,
      requestId: 5,
      controlId: 5,
      sequence: 5,
      phase: "running",
    });
    expect(getBrowserAutomationActivity(7)).toBe("find");
  });
  afterEach(() => {
    clearBrowserAutomationActivity(7);
    vi.useRealTimers();
    vi.unstubAllGlobals();
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

  it("tracks background activity without mounting a subscribed UI indicator", () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {});
    ensureBrowserAutomationActivityListener();
    ensureBrowserAutomationActivityListener();
    expect(listen).toHaveBeenCalledTimes(1);
    const callback = vi.mocked(listen).mock.calls[0]?.[1];
    if (!callback) throw new Error("Shared activity listener was not bound");
    callback({
      event: "browser-automation-activity",
      id: 1,
      payload: {
        tabId: 7,
        requestId: 1,
        sequence: 1,
        method: "hover",
        phase: "running",
        actor: { brand: "codex" },
      },
    });
    expect(getBrowserAutomationState(7)?.actor.brand).toBe("codex");
    expect(getBrowserAutomationActivity(7)).toBe("hover");
  });

  it("keeps caller ownership through queued and late events, then expires", () => {
    vi.useFakeTimers();
    const payload = (requestId: number, sequence: number, phase: string) => ({
      tabId: 7,
      requestId,
      sequence,
      method: "click",
      phase,
      actor: { brand: requestId === 1 ? "codex" : "claude" },
    });
    receiveBrowserAutomationActivity(payload(1, 1, "running"));
    receiveBrowserAutomationActivity(payload(2, 2, "queued"));
    expect(getBrowserAutomationState(7)?.actor.brand).toBe("codex");
    receiveBrowserAutomationActivity(payload(2, 3, "running"));
    receiveBrowserAutomationActivity(payload(1, 4, "done"));
    expect(getBrowserAutomationState(7)?.actor.brand).toBe("claude");
    vi.advanceTimersByTime(30_000);
    expect(getBrowserAutomationActivity(7)).toBe("click");
    receiveBrowserAutomationActivity(payload(2, 5, "done"));
    vi.advanceTimersByTime(1800);
    expect(getBrowserAutomationState(7)).toBeNull();
    expect(getBrowserAutomationActivity(7)).toBeNull();
  });

  it("clears rich identity on close and does not give a legacy caller the previous logo", () => {
    vi.useFakeTimers();
    const payload = {
      tabId: 7,
      requestId: 1,
      sequence: 1,
      method: "hover",
      phase: "running",
      actor: { brand: "codex" },
    };
    receiveBrowserAutomationActivity(payload);
    receiveBrowserAutomationActivity({ method: "click", params: { tabId: 7 } });
    expect(getBrowserAutomationState(7)).toBeNull();
    expect(getBrowserAutomationActivity(7)).toBe("click");
    receiveBrowserAutomationActivity(payload);
    clearBrowserAutomationActivity(7);
    expect(getBrowserAutomationState(7)).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});
