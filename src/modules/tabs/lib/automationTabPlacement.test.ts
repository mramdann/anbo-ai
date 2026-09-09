import { describe, expect, it } from "vitest";
import { createAutomationTabSelection } from "./automationTabPlacement";

describe("shared automation tab selection", () => {
  it("reserves the first selection across creator types until its tab commits", () => {
    const selection = createAutomationTabSelection();
    const first = selection.placement("a", "a", []);
    expect(first).toBe("visible-first-tab");
    selection.created("a", 1, first);
    expect(selection.placement("a", "a", [])).toBe("visible-background-tab");
    selection.reconcile([{ id: 1 }]);
    expect(selection.placement("a", "a", [{ spaceId: "a" }])).toBe(
      "visible-background-tab",
    );
    expect(selection.placement("a", "a", [])).toBe("visible-first-tab");
  });
  it.each(["browser", "terminal", "agent", "file"])(
    "counts an existing %s as an occupied workspace",
    (kind) => {
      const selection = createAutomationTabSelection();
      const tabs = [{ spaceId: "a", kind }];
      expect(selection.placement("a", "a", tabs)).toBe(
        "visible-background-tab",
      );
    },
  );
  it("keeps reservations isolated and never activates another workspace", () => {
    const selection = createAutomationTabSelection();
    selection.created("a", 1, selection.placement("a", "a", []));
    expect(selection.placement("b", "a", [])).toBe("inactive-workspace");
    expect(selection.placement("b", null, [])).toBe("inactive-workspace");
    expect(selection.placement("b", "b", [])).toBe("visible-first-tab");
  });
  it("rechecks current selection after an asynchronous agent admission", () => {
    const selection = createAutomationTabSelection();
    expect(selection.placement("a", "b", [])).toBe("inactive-workspace");
    expect(selection.placement("a", "a", [{ spaceId: "a" }])).toBe(
      "visible-background-tab",
    );
  });
  it("releases an uncommitted first tab only when that tab closes", () => {
    const selection = createAutomationTabSelection();
    selection.created("a", 1, "visible-first-tab");
    selection.closed(2);
    selection.reconcile([{ id: 2 }]);
    expect(selection.placement("a", "a", [])).toBe("visible-background-tab");
    selection.closed(1);
    expect(selection.placement("a", "a", [])).toBe("visible-first-tab");
  });
  it("does not reserve an inactive or background open", () => {
    const selection = createAutomationTabSelection();
    selection.created("a", 1, "inactive-workspace");
    selection.created("a", 2, "visible-background-tab");
    expect(selection.placement("a", "a", [])).toBe("visible-first-tab");
  });
});
