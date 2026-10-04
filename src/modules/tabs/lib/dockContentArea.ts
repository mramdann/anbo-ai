import {
  type CSSProperties,
  type RefObject,
  useLayoutEffect,
  useState,
} from "react";

/** A box inside the dock container, each side a fraction of the dock's size. */
export type DockArea = {
  top: number;
  left: number;
  width: number;
  height: number;
};

/**
 * Where a panel's content sits inside the dock: the active group's content
 * box (below its tab strip), which is where a new tab lands.
 *
 * Tabs that are not visible in the dock render in hidden hosts outside
 * dockview, which used to cover the whole dock area. A browser tab opened
 * behind the visible one was laid out 31 px taller there and shrank when it
 * came forward, so the page moved under an agent that had already measured
 * it; a background terminal resized its PTY the same way.
 *
 * Fractions rather than pixels: the UI zoom setting scales the app with CSS
 * zoom, so a measured box set back as a pixel style is scaled by the zoom a
 * second time (at 95% a background tab came out 5% too small), while a share
 * of the dock stays the same share at any zoom.
 */
export function dockContentArea(container: HTMLElement): DockArea | null {
  const group =
    container.querySelector<HTMLElement>(".dv-groupview.dv-active-group") ??
    container.querySelector<HTMLElement>(".dv-groupview");
  const content = group?.querySelector<HTMLElement>(
    ":scope > .dv-content-container",
  );
  if (!content) return null;
  const outer = container.getBoundingClientRect();
  const inner = content.getBoundingClientRect();
  if (outer.width < 1 || outer.height < 1) return null;
  if (inner.width < 1 || inner.height < 1) return null;
  return {
    top: (inner.top - outer.top) / outer.height,
    left: (inner.left - outer.left) / outer.width,
    width: inner.width / outer.width,
    height: inner.height / outer.height,
  };
}

/** The style that places a hidden host over `area`, or over the whole dock. */
export function dockAreaStyle(area: DockArea | null): CSSProperties {
  if (!area) return { inset: 0 };
  const percent = (value: number) => `${value * 100}%`;
  return {
    top: percent(area.top),
    left: percent(area.left),
    width: percent(area.width),
    height: percent(area.height),
  };
}

function sameArea(a: DockArea | null, b: DockArea | null): boolean {
  return (
    a === b ||
    (!!a &&
      !!b &&
      a.top === b.top &&
      a.left === b.left &&
      a.width === b.width &&
      a.height === b.height)
  );
}

/** dockContentArea for a container, kept current as the dock or the active
 *  group's content resizes and whenever `revision` changes (another tab or
 *  group active, tabs shown or hidden). */
export function useDockContentArea(
  containerRef: RefObject<HTMLElement | null>,
  revision: string,
): DockArea | null {
  const [area, setArea] = useState<DockArea | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision only marks when to measure again
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let frame = 0;
    let watched: Element | null = null;
    const observer = new ResizeObserver(() => {
      if (!frame) frame = requestAnimationFrame(measure);
    });
    function measure() {
      frame = 0;
      const next = dockContentArea(container as HTMLElement);
      setArea((current) => (sameArea(current, next) ? current : next));
      // Follow the content box itself too: a split's sash moves it without
      // resizing the dock.
      const content = (container as HTMLElement).querySelector(
        ".dv-groupview.dv-active-group > .dv-content-container",
      );
      if (content !== watched) {
        if (watched) observer.unobserve(watched);
        if (content) observer.observe(content);
        watched = content;
      }
    }
    observer.observe(container);
    measure();
    return () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [containerRef, revision]);
  return area;
}
