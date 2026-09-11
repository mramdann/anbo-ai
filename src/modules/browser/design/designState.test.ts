import { beforeEach, describe, expect, it, vi } from "vitest";

const designSet = vi.fn(async (tabId: number, active: boolean) => ({
  tabId,
  active,
  tool: "box" as const,
  marks: 0,
  dirty: false,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));
vi.mock("@/modules/browser/native", () => ({
  BROWSER_DESIGN_EVENT: "anbo:browser-design",
  browserDesignSet: designSet,
}));

const {
  applyBrowserDesignStatus,
  getBrowserDesignStatus,
  parseBrowserDesignEvent,
  parseBrowserDesignStatus,
  receiveBrowserDesignEvent,
} = await import("./designState");

describe("browser design state", () => {
  beforeEach(() => {
    designSet.mockClear();
  });

  it("accepts only well-formed statuses from the backend", () => {
    expect(
      parseBrowserDesignStatus({
        tabId: 3,
        active: true,
        tool: "pen",
        marks: 2,
        dirty: true,
        limit: "",
      }),
    ).toEqual({ tabId: 3, active: true, tool: "pen", marks: 2, dirty: true });
    expect(
      parseBrowserDesignStatus({
        tabId: 0,
        active: true,
        tool: "pen",
        marks: 0,
      }),
    ).toBeNull();
    expect(
      parseBrowserDesignStatus({
        tabId: 3,
        active: "yes",
        tool: "pen",
        marks: 0,
      }),
    ).toBeNull();
    expect(
      parseBrowserDesignStatus({
        tabId: 3,
        active: true,
        tool: "laser",
        marks: 0,
      }),
    ).toBeNull();
    expect(
      parseBrowserDesignStatus({
        tabId: 3,
        active: true,
        tool: "box",
        marks: -1,
      }),
    ).toBeNull();
    expect(parseBrowserDesignStatus(null)).toBeNull();
  });

  it("reads the event kind and falls back to a state update", () => {
    const base = {
      tabId: 4,
      active: true,
      tool: "box",
      marks: 1,
      dirty: false,
    };
    expect(parseBrowserDesignEvent({ ...base, kind: "exit" })?.kind).toBe(
      "exit",
    );
    expect(parseBrowserDesignEvent({ ...base, kind: "unknown" })?.kind).toBe(
      "state",
    );
    expect(parseBrowserDesignEvent({ ...base })?.kind).toBe("state");
  });

  it("tracks active tabs and forgets inactive ones", () => {
    applyBrowserDesignStatus({
      tabId: 5,
      active: true,
      tool: "arrow",
      marks: 3,
      dirty: true,
    });
    expect(getBrowserDesignStatus(5)).toMatchObject({
      active: true,
      tool: "arrow",
      marks: 3,
    });
    applyBrowserDesignStatus({
      tabId: 5,
      active: false,
      tool: "arrow",
      marks: 3,
      dirty: false,
    });
    expect(getBrowserDesignStatus(5)).toMatchObject({
      active: false,
      marks: 0,
      tool: "box",
    });
    expect(getBrowserDesignStatus(5)).toBe(getBrowserDesignStatus(5));
  });

  it("closes design mode when the page asks to exit, and only then", async () => {
    receiveBrowserDesignEvent({
      tabId: 6,
      kind: "exit",
      active: true,
      tool: "box",
      marks: 1,
      dirty: true,
    });
    expect(designSet).toHaveBeenCalledWith(6, false);
    await Promise.resolve();
    await Promise.resolve();
    expect(getBrowserDesignStatus(6).active).toBe(false);
    receiveBrowserDesignEvent({
      tabId: 7,
      kind: "state",
      active: true,
      tool: "pen",
      marks: 1,
      dirty: true,
    });
    expect(designSet).toHaveBeenCalledTimes(1);
    expect(getBrowserDesignStatus(7).tool).toBe("pen");
  });
});
