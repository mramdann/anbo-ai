import { describe, expect, it, vi } from "vitest";
import {
  browserOpenPlacement,
  createBrowserCloseListener,
  createBrowserOpenListener,
  createBrowserTabsListener,
  resolveBrowserCloseTarget,
  resolveBrowserOpenSpace,
} from "./automationOpen";

const spaces = [
  { id: "a", root: "C:\\work\\alpha", env: { kind: "local" as const } },
  { id: "b", root: "/home/user/beta", env: { kind: "wsl" as const } },
];

describe("resolveBrowserOpenSpace", () => {
  it("rejects an omitted or blank workspace instead of using UI focus", () => {
    const expected = {
      ok: false,
      error:
        "browser_open requires a workspace root or space id; the active UI workspace is never used as a fallback",
    };
    expect(resolveBrowserOpenSpace(spaces)).toEqual(expected);
    expect(resolveBrowserOpenSpace(spaces, "  ")).toEqual(expected);
  });

  it("does not retarget an agent when UI focus changes", () => {
    expect(resolveBrowserOpenSpace(spaces, "C:/work/alpha")).toEqual({
      ok: true,
      space: spaces[0],
    });
  });

  it("matches local roots across slash style and casing", () => {
    expect(resolveBrowserOpenSpace(spaces, "c:/WORK/alpha/")).toEqual({
      ok: true,
      space: spaces[0],
    });
  });

  it("accepts a stable space id and rejects an unknown workspace", () => {
    expect(resolveBrowserOpenSpace(spaces, "b")).toEqual({
      ok: true,
      space: spaces[1],
    });
    expect(resolveBrowserOpenSpace(spaces, "C:/work/missing")).toEqual({
      ok: false,
      error: "workspace is not open in Anbo: C:/work/missing",
    });
  });
});

describe("browserOpenPlacement", () => {
  it("distinguishes visible background tabs from inactive workspace tabs", () => {
    expect(browserOpenPlacement("a", "a")).toBe("visible-background-tab");
    expect(browserOpenPlacement("b", "a")).toBe("inactive-workspace");
  });
});

describe("resolveBrowserCloseTarget", () => {
  const tabs = [
    { id: 7, kind: "browser", spaceId: "a" },
    { id: 8, kind: "browser", spaceId: "b" },
    { id: 9, kind: "terminal", spaceId: "a" },
  ];

  it("resolves only a browser tab owned by the requested workspace", () => {
    expect(resolveBrowserCloseTarget(tabs, spaces, 7, "C:/work/alpha")).toEqual(
      {
        ok: true,
        space: spaces[0],
        tab: tabs[0],
      },
    );
  });

  it("rejects cross-workspace and non-browser tab closure", () => {
    expect(resolveBrowserCloseTarget(tabs, spaces, 8, "a")).toEqual({
      ok: false,
      error: "browser tab 8 is not open in workspace: a",
    });
    expect(resolveBrowserCloseTarget(tabs, spaces, 9, "a")).toEqual({
      ok: false,
      error: "browser tab 9 is not open in workspace: a",
    });
  });
});

describe("parallel workspace resolution", () => {
  it("resolves ten independent workspace roots without foreground coupling", () => {
    const manySpaces = Array.from({ length: 10 }, (_, index) => ({
      id: `space-${index + 1}`,
      root: `C:\\work\\project-${index + 1}`,
      env: { kind: "local" as const },
    }));

    for (const [index, space] of manySpaces.entries()) {
      expect(
        resolveBrowserOpenSpace(manySpaces, `c:/WORK/project-${index + 1}`),
      ).toEqual({ ok: true, space });
    }
  });
});

describe("createBrowserOpenListener", () => {
  it("keeps one subscription while replacing its live handler", async () => {
    let subscribed = 0;
    const sink: {
      incoming?: (request: { requestId: string; url: string }) => void;
    } = {};
    const dispose = vi.fn();
    const listener = createBrowserOpenListener(async (handler) => {
      subscribed += 1;
      sink.incoming = handler;
      return dispose;
    });
    const first = vi.fn();
    const second = vi.fn();

    listener.setHandler(first);
    await Promise.resolve();
    listener.setHandler(second);
    sink.incoming?.({ requestId: "1", url: "https://example.com" });

    expect(subscribed).toBe(1);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
    listener.stop();
    expect(dispose).toHaveBeenCalledOnce();
  });
});

describe("createBrowserCloseListener", () => {
  it("routes close requests through one replaceable subscription", async () => {
    let subscribed = 0;
    const sink: {
      incoming?: (request: {
        requestId: string;
        tabId: number;
        workspace: string;
      }) => void;
    } = {};
    const dispose = vi.fn();
    const listener = createBrowserCloseListener(async (handler) => {
      subscribed += 1;
      sink.incoming = handler;
      return dispose;
    });
    const first = vi.fn();
    const second = vi.fn();

    listener.setHandler(first);
    await Promise.resolve();
    listener.setHandler(second);
    sink.incoming?.({ requestId: "1", tabId: 7, workspace: "a" });

    expect(subscribed).toBe(1);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
    listener.stop();
    expect(dispose).toHaveBeenCalledOnce();
  });
});

describe("createBrowserTabsListener", () => {
  it("keeps one subscription while exposing the latest metadata handler", async () => {
    let subscribed = 0;
    const sink: { incoming?: (request: { requestId: string }) => void } = {};
    const dispose = vi.fn();
    const listener = createBrowserTabsListener(async (handler) => {
      subscribed += 1;
      sink.incoming = handler;
      return dispose;
    });
    const first = vi.fn();
    const second = vi.fn();

    listener.setHandler(first);
    await Promise.resolve();
    listener.setHandler(second);
    sink.incoming?.({ requestId: "tabs-1" });

    expect(subscribed).toBe(1);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith({ requestId: "tabs-1" });
    listener.stop();
    expect(dispose).toHaveBeenCalledOnce();
  });
});
