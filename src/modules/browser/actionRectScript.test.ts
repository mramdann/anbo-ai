import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

const source = readFileSync(
  new URL(
    "../../../src-tauri/src/modules/browser_automation/actionRect.js",
    import.meta.url,
  ),
  "utf8",
);
const rect = (left: number, top: number, width = 60, height = 20) => ({
  left,
  top,
  width,
  height,
});

describe("action target scrolling", () => {
  function prepare(
    initial = rect(30, 100),
    hit = true,
    scroll = true,
    position?: { x: number; y: number },
  ) {
    let bounds = initial;
    const element = {
      getClientRects: () => [bounds],
      scrollIntoView: vi.fn(() => {
        bounds = rect(30, 100);
      }),
    };
    const result = vm.runInNewContext(
      `${source}; prepareActionPoint(element, scroll, position)`,
      {
        innerWidth: 600,
        innerHeight: 500,
        element,
        scroll,
        position,
        document: { elementFromPoint: () => (hit ? element : null) },
      },
    );
    return { result, element };
  }

  it("does not center an already hittable visible control", () => {
    const { result, element } = prepare(rect(500, 450));
    expect(result).toMatchObject({ x: 530, y: 460, inViewport: true });
    expect(element.scrollIntoView).not.toHaveBeenCalled();
  });

  it("moves to an explicit relative position without changing the target bounds", () => {
    const { result, element } = prepare(rect(100, 50, 200, 100), true, true, {
      x: 0.6,
      y: 0.25,
    });
    expect(result).toMatchObject({
      x: 220,
      y: 75,
      centerX: 200,
      centerY: 100,
      width: 200,
      height: 100,
      inViewport: true,
    });
    expect(element.scrollIntoView).not.toHaveBeenCalled();
  });

  it("checks the requested position rather than the center for pointer interception", () => {
    const element = { getClientRects: () => [rect(100, 50, 200, 100)] };
    const elementFromPoint = vi.fn(() => null);
    const result = vm.runInNewContext(
      `${source}; receivesActionPointer(element, prepareActionPoint(element, false, {x:0.6,y:0.5}))`,
      {
        element,
        innerWidth: 600,
        innerHeight: 500,
        document: { elementFromPoint },
      },
    );
    expect(result).toBe(false);
    expect(elementFromPoint).toHaveBeenCalledWith(220, 100);
  });

  it("recomputes the relative position after one scroll", () => {
    const { result, element } = prepare(rect(30, 900), true, true, {
      x: 0.75,
      y: 0.5,
    });
    expect(element.scrollIntoView).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ x: 75, y: 110, inViewport: true });
  });

  it("scrolls an offscreen control instantly once and measures its new position", () => {
    const { result, element } = prepare(rect(30, 900));
    expect(element.scrollIntoView).toHaveBeenCalledExactlyOnceWith({
      block: "center",
      inline: "center",
      behavior: "instant",
    });
    expect(result).toMatchObject({ x: 60, y: 110, inViewport: true });
  });

  it("can expose a target clipped inside a nested scroller", () => {
    expect(
      prepare(rect(30, 100), false).element.scrollIntoView,
    ).toHaveBeenCalledOnce();
  });

  it("does not keep scrolling during stability polling", () => {
    const { result, element } = prepare(rect(30, 900), false, false);
    expect(result.inViewport).toBe(false);
    expect(element.scrollIntoView).not.toHaveBeenCalled();
  });

  it("recognizes composed slot ancestry when checking the hit target", () => {
    const element = {};
    const child = { assignedSlot: { parentNode: element } };
    const result = vm.runInNewContext(
      `${source}; receivesActionPointer(element, point)`,
      {
        element,
        point: { x: 20, y: 20, inViewport: true },
        document: { elementFromPoint: () => child },
      },
    );
    expect(result).toBe(true);
  });

  it("bounds composed hit-target ancestry", () => {
    const element = {};
    const cyclic: { parentNode?: unknown } = {};
    cyclic.parentNode = cyclic;
    expect(
      vm.runInNewContext(
        `${source}; receivesActionPointer(element, point)`,
        {
          element,
          point: { x: 20, y: 20, inViewport: true },
          document: { elementFromPoint: () => cyclic },
        },
        { timeout: 100 },
      ),
    ).toBe(false);
  });
});
function pick(
  fragments: ReturnType<typeof rect>[],
  bounds = rect(0, 0, 500, 100),
  position?: { x: number; y: number },
) {
  return vm.runInNewContext(`${source}; actionRect(element, position)`, {
    innerWidth: 600,
    innerHeight: 500,
    position,
    element: {
      getClientRects: () => fragments,
      getBoundingClientRect: () => bounds,
    },
  });
}

describe("native action target fragments", () => {
  it("targets a painted line instead of the empty center of a wrapped link", () => {
    const first = rect(400, 100, 150);
    expect(pick([first, rect(30, 120)])).toBe(first);
  });
  it("skips empty and offscreen fragments when a visible one exists", () => {
    const visible = rect(30, 100);
    expect(pick([rect(0, 0, 0, 0), rect(0, -100), visible])).toBe(visible);
  });
  it("selects a fragment where the requested position is inside the viewport", () => {
    const centeredOnly = rect(500, 100, 150);
    const visible = rect(30, 120);
    expect(pick([centeredOnly, visible], undefined, { x: 0.9, y: 0.5 })).toBe(
      visible,
    );
  });
  it("bounds fragment inspection and retains offscreen rejection", () => {
    const first = rect(-100, -100);
    expect(pick([...Array(32).fill(first), rect(50, 50)])).toBe(first);
  });
  it("falls back to bounds for elements without painted fragments", () => {
    const bounds = rect(10, 20);
    expect(pick([], bounds)).toBe(bounds);
  });
});
