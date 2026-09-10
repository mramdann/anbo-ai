import { afterEach, describe, expect, it, vi } from "vitest";
import { listen } from "@tauri-apps/api/event";
import {
  browserAutomationActivityFromPayload,
  clearBrowserAutomationActivity,
  ensureBrowserAutomationActivityListener,
  getBrowserAutomationActivity,
  getBrowserAutomationActor,
  getBrowserAutomationState,
  isBrowserAutomationFocused,
  markBrowserAutomationActivity,
  receiveBrowserAutomationActivity,
} from "./automationActivity";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

const CODEX = { brand: "codex", label: "Codex" };

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

  it("names the controlling agent from the open request, before any tracked action", () => {
    // browser_open cannot be tracked: the tab has no id when the call starts, so
    // the open request is the only thing that can name the controller before the
    // first tracked action lands. Reading identity off the activity instead is
    // what made a freshly driven tab show the generic robot and swap to the real
    // logo a call later.
    const opencode = { brand: "opencode", label: "OpenCode" };
    markBrowserAutomationActivity(11, "open", opencode);
    expect(getBrowserAutomationActor(11)).toEqual(opencode);
    expect(getBrowserAutomationState(11)).toBeNull();

    // A tracked action arrives; the identity must survive it, not be replaced by
    // a second source of truth.
    receiveBrowserAutomationActivity({
      tabId: 11,
      requestId: 4,
      controlId: 4,
      sequence: 4,
      method: "click",
      phase: "running",
      actor: { brand: "opencode" },
    });
    expect(getBrowserAutomationActor(11)).toEqual(opencode);

    // Ending the session takes the identity with it.
    receiveBrowserAutomationActivity({
      tabId: 11,
      requestId: 4,
      controlId: 4,
      sequence: 5,
      method: "click",
      phase: "ended",
      actor: { brand: "opencode" },
    });
    expect(getBrowserAutomationActor(11)).toBeNull();
  });

  it("keeps one indicator per agent and moves it to the tab being driven", () => {
    // An agent can hold several tabs at once but only ever works one of them at
    // a time. Lighting up every held tab answered "an agent is somewhere in
    // here" when the question worth answering is which tab it is in, so the
    // badge lives on the tab being driven and moves with it.
    const opencode = { brand: "opencode", label: "OpenCode" };
    markBrowserAutomationActivity(31, "open", opencode);
    markBrowserAutomationActivity(32, "open", opencode);
    expect(isBrowserAutomationFocused(32)).toBe(true);
    expect(isBrowserAutomationFocused(31)).toBe(false);

    // Going back to the first tab brings the badge back with it.
    receiveBrowserAutomationActivity({
      tabId: 31,
      requestId: 40,
      controlId: 40,
      sequence: 40,
      method: "click",
      phase: "running",
      actor: { brand: "opencode" },
    });
    expect(isBrowserAutomationFocused(31)).toBe(true);
    expect(isBrowserAutomationFocused(32)).toBe(false);

    // A second agent keeps its own, and does not take the first one's.
    markBrowserAutomationActivity(33, "open", {
      brand: "codex",
      label: "Codex",
    });
    expect(isBrowserAutomationFocused(33)).toBe(true);
    expect(isBrowserAutomationFocused(31)).toBe(true);

    // Ending the session lets the badge go, rather than pinning it to a tab
    // nobody is driving any more.
    receiveBrowserAutomationActivity({
      tabId: 31,
      requestId: 40,
      controlId: 40,
      sequence: 41,
      method: "click",
      phase: "ended",
      actor: { brand: "opencode" },
    });
    expect(isBrowserAutomationFocused(31)).toBe(false);

    for (const id of [31, 32, 33]) clearBrowserAutomationActivity(id);
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
    markBrowserAutomationActivity(7, "navigate", CODEX, 1_000);
    expect(getBrowserAutomationActivity(7)).toBe("navigate");

    vi.advanceTimersByTime(750);
    markBrowserAutomationActivity(7, "snapshot", CODEX, 1_000);
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
