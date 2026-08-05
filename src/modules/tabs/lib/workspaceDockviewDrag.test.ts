import { describe, expect, it } from "vitest";
import {
  calculateLinearReorderGap,
  resolveWorkspaceDockviewEdgeZone,
  resolveWorkspaceDockviewHeaderTarget,
  workspaceDockviewEdgePreviewRect,
} from "./workspaceDockviewDrag";

const rect = {
  left: 100,
  right: 500,
  top: 50,
  bottom: 350,
  width: 400,
  height: 300,
};

describe("resolveWorkspaceDockviewEdgeZone", () => {
  it("resolves each outer edge band", () => {
    expect(resolveWorkspaceDockviewEdgeZone(rect, 110, 200)).toBe("left");
    expect(resolveWorkspaceDockviewEdgeZone(rect, 490, 200)).toBe("right");
    expect(resolveWorkspaceDockviewEdgeZone(rect, 300, 60)).toBe("top");
    expect(resolveWorkspaceDockviewEdgeZone(rect, 300, 340)).toBe("bottom");
  });

  it("uses the nearest edge in a corner", () => {
    expect(resolveWorkspaceDockviewEdgeZone(rect, 108, 70)).toBe("left");
    expect(resolveWorkspaceDockviewEdgeZone(rect, 120, 55)).toBe("top");
  });

  it("rejects the center and points outside the content", () => {
    expect(resolveWorkspaceDockviewEdgeZone(rect, 300, 200)).toBeNull();
    expect(resolveWorkspaceDockviewEdgeZone(rect, 90, 200)).toBeNull();
  });
});

describe("workspaceDockviewEdgePreviewRect", () => {
  it("uses the complete target group bounds for horizontal splits", () => {
    expect(workspaceDockviewEdgePreviewRect(rect, "left")).toEqual({
      left: 100,
      top: 50,
      width: 200,
      height: 300,
    });
    expect(workspaceDockviewEdgePreviewRect(rect, "right")).toEqual({
      left: 300,
      top: 50,
      width: 200,
      height: 300,
    });
  });

  it("uses the complete target group bounds for vertical splits", () => {
    expect(workspaceDockviewEdgePreviewRect(rect, "top")).toEqual({
      left: 100,
      top: 50,
      width: 400,
      height: 150,
    });
    expect(workspaceDockviewEdgePreviewRect(rect, "bottom")).toEqual({
      left: 100,
      top: 200,
      width: 400,
      height: 150,
    });
  });
});

describe("calculateLinearReorderGap", () => {
  const ids = [1, 2, 3, 4];

  it("keeps pre-removal gap semantics when moving right", () => {
    expect(calculateLinearReorderGap(ids, 1, 3, "before")).toBe(2);
    expect(calculateLinearReorderGap(ids, 1, 3, "after")).toBe(3);
  });

  it("keeps pre-removal gap semantics when moving left", () => {
    expect(calculateLinearReorderGap(ids, 4, 2, "before")).toBe(1);
    expect(calculateLinearReorderGap(ids, 4, 2, "after")).toBe(2);
  });

  it("rejects self and unknown tab targets", () => {
    expect(calculateLinearReorderGap(ids, 2, 2, "before")).toBeNull();
    expect(calculateLinearReorderGap(ids, 2, 9, "after")).toBeNull();
  });
});

describe("resolveWorkspaceDockviewHeaderTarget", () => {
  const tabs = [
    { tabId: 7, rect: { left: 0, right: 100, width: 100 } },
    { tabId: 2, rect: { left: 100, right: 200, width: 100 } },
    { tabId: 9, rect: { left: 200, right: 300, width: 100 } },
  ];

  it("targets the direct tab half instead of the panel after its gap", () => {
    expect(resolveWorkspaceDockviewHeaderTarget(tabs, 175, 2)).toEqual({
      tabId: 2,
      placement: "after",
      gapIndex: 2,
    });
    expect(resolveWorkspaceDockviewHeaderTarget(tabs, 225, 9)).toEqual({
      tabId: 9,
      placement: "before",
      gapIndex: 2,
    });
  });

  it("uses the nearest boundary when the pointer is in header chrome", () => {
    expect(resolveWorkspaceDockviewHeaderTarget(tabs, 90, null)).toEqual({
      tabId: 7,
      placement: "after",
      gapIndex: 1,
    });
    expect(resolveWorkspaceDockviewHeaderTarget(tabs, 330, null)).toEqual({
      tabId: 9,
      placement: "after",
      gapIndex: 3,
    });
  });

  it("derives equivalent targets for another split group's local order", () => {
    const splitGroupTabs = [
      { tabId: 12, rect: { left: 400, right: 480, width: 80 } },
      { tabId: 4, rect: { left: 480, right: 560, width: 80 } },
    ];

    expect(
      resolveWorkspaceDockviewHeaderTarget(splitGroupTabs, 545, 4),
    ).toEqual({ tabId: 4, placement: "after", gapIndex: 2 });
  });
});
