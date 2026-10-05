import { describe, expect, it, vi } from "vitest";
import {
  planBrowserTabShow,
  registerBrowserTabShow,
  showBrowserTabForInput,
  subscribeBrowserTabShown,
} from "./browserTabShow";

describe("showBrowserTabForInput", () => {
  it("asks the shown workspace's dock and tells the tab when it came forward", () => {
    const show = vi.fn((tabId: number) => (tabId === 7 ? "shown" : "in-use"));
    const unregister = registerBrowserTabShow("space-a", show);
    const shown = vi.fn();
    const unsubscribe = subscribeBrowserTabShown(shown);

    expect(showBrowserTabForInput("space-a", 7)).toBe("shown");
    expect(showBrowserTabForInput("space-a", 8)).toBe("in-use");
    expect(shown.mock.calls).toEqual([[7]]);

    unsubscribe();
    unregister();
  });

  it("never reaches the dock of another workspace or one that unmounted", () => {
    const show = vi.fn(() => "shown" as const);
    const unregister = registerBrowserTabShow("space-a", show);
    const shown = vi.fn();
    const unsubscribe = subscribeBrowserTabShown(shown);

    expect(showBrowserTabForInput("space-b", 7)).toBe("missing");
    unregister();
    expect(showBrowserTabForInput("space-a", 7)).toBe("missing");
    expect(show).not.toHaveBeenCalled();
    expect(shown).not.toHaveBeenCalled();

    unsubscribe();
  });

  it("keeps a newer dock when an older one unregisters late", () => {
    const older = registerBrowserTabShow("space-a", () => "in-use");
    const newer = registerBrowserTabShow("space-a", () => "shown");
    older();
    expect(showBrowserTabForInput("space-a", 7)).toBe("shown");
    newer();
  });
});

describe("planBrowserTabShow", () => {
  const panel = {
    found: true,
    front: false,
    groupInUse: false,
    frontIsBrowser: false,
  };

  it("reveals the tab in a group the user is not in", () => {
    expect(planBrowserTabShow(panel)).toEqual({
      outcome: "shown",
      step: "reveal",
    });
  });

  it("leaves a tab already in front where it is", () => {
    expect(planBrowserTabShow({ ...panel, front: true })).toEqual({
      outcome: "shown",
      step: "none",
    });
    expect(
      planBrowserTabShow({ ...panel, front: true, groupInUse: true }),
    ).toEqual({ outcome: "shown", step: "none" });
  });

  it("changes the group in use only from another browser tab", () => {
    expect(
      planBrowserTabShow({ ...panel, groupInUse: true, frontIsBrowser: true }),
    ).toEqual({ outcome: "shown", step: "select" });
    expect(planBrowserTabShow({ ...panel, groupInUse: true })).toEqual({
      outcome: "in-use",
      step: "none",
    });
  });

  it("reports a tab the layout does not hold", () => {
    expect(planBrowserTabShow({ ...panel, found: false })).toEqual({
      outcome: "missing",
      step: "none",
    });
  });
});
