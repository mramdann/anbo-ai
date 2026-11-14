import { describe, expect, it, vi } from "vitest";
import {
  noteUserUsedBrowserTab,
  planBrowserTabShow,
  registerBrowserTabShow,
  showBrowserTabForInput,
  subscribeBrowserTabShown,
  subscribeUserUsedBrowserTab,
  usersPageAfterUse,
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
    inFront: "other" as const,
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

  it("changes the group in use only from another page", () => {
    expect(
      planBrowserTabShow({ ...panel, groupInUse: true, inFront: "page" }),
    ).toEqual({ outcome: "shown", step: "select" });
    expect(planBrowserTabShow({ ...panel, groupInUse: true })).toEqual({
      outcome: "in-use",
      step: "none",
    });
  });

  it("leaves the page the user chose in front, wherever the user is", () => {
    // Round 102: the user had left a page of their own in front of the
    // browser panel and came back to the workspace, where Anbo puts the
    // caret into a terminal; a real agent's tab then took the panel.
    for (const groupInUse of [true, false]) {
      expect(
        planBrowserTabShow({ ...panel, groupInUse, inFront: "users-page" }),
      ).toEqual({ outcome: "in-use-page", step: "none" });
    }
    // Any other page still gives way in a group the user is not in.
    expect(planBrowserTabShow({ ...panel, inFront: "page" })).toEqual({
      outcome: "shown",
      step: "reveal",
    });
  });

  it("reports a tab the layout does not hold", () => {
    expect(planBrowserTabShow({ ...panel, found: false })).toEqual({
      outcome: "missing",
      step: "none",
    });
  });
});

describe("the page the user chose in a browser panel", () => {
  it("is the tab they used themselves, unless an agent ever drove it", () => {
    expect(usersPageAfterUse({ id: 7, everDriven: false })).toBe(7);
    // The user looks at an agent's tab to watch it: agents' tabs come
    // forward by themselves again, also once that agent's session is over.
    expect(usersPageAfterUse({ id: 8, everDriven: true })).toBeNull();
  });

  it("is told to whoever listens, and no longer after they stop", () => {
    const used = vi.fn();
    const stop = subscribeUserUsedBrowserTab(used);
    noteUserUsedBrowserTab(7);
    stop();
    noteUserUsedBrowserTab(8);
    expect(used.mock.calls).toEqual([[7]]);
  });
});
