import { describe, expect, it } from "vitest";
import { planSpaceRemoval, type Tab } from "./useTabs";

function term(id: number, spaceId: string): Tab {
  return {
    id,
    kind: "terminal",
    spaceId,
    title: "shell",
    paneTree: { kind: "leaf", id: id * 10 },
    activeLeafId: id * 10,
  } as Tab;
}

describe("planSpaceRemoval", () => {
  it("returns null when the space has no tabs", () => {
    const tabs = [term(1, "a"), term(2, "a")];
    expect(planSpaceRemoval(tabs, 1, "b", "a")).toBeNull();
  });

  it("drops every tab of the deleted space and disposes their leaves", () => {
    const tabs = [term(1, "a"), term(2, "a"), term(3, "b")];
    const plan = planSpaceRemoval(tabs, 1, "a", "b");
    expect(plan).not.toBeNull();
    expect(plan?.tabs.map((t) => t.id)).toEqual([3]);
    expect(plan?.disposeLeafIds).toEqual([10, 20]);
  });

  it("repoints active to the fallback space's last tab when the active tab is removed", () => {
    const tabs = [term(1, "a"), term(2, "b"), term(3, "b")];
    const plan = planSpaceRemoval(tabs, 1, "a", "b");
    expect(plan?.activeId).toBe(3);
  });

  it("keeps the active tab when it survives the removal", () => {
    const tabs = [term(1, "a"), term(2, "b"), term(3, "b")];
    const plan = planSpaceRemoval(tabs, 3, "a", "b");
    expect(plan?.activeId).toBe(3);
  });

  it("leaves the fallback space empty rather than spawning a shell into it", () => {
    // An empty space shows its launch deck; a shell nobody asked for would
    // pre-empt that choice.
    const tabs = [term(1, "a"), term(2, "a")];
    const plan = planSpaceRemoval(tabs, 1, "a", "b");
    expect(plan?.tabs).toEqual([]);
    expect(plan?.activeId).toBe(-1);
    expect(plan?.disposeLeafIds).toEqual([10, 20]);
  });
});
