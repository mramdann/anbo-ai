import { type CSSProperties, useCallback, useRef, useState } from "react";

/** A box inside the dock container, each side a fraction of the dock's size. */
export type DockArea = {
  top: number;
  left: number;
  width: number;
  height: number;
};

/** Marks the group a tidy layout keeps browser tabs in. */
export const BROWSER_PANEL_ATTRIBUTE = "data-anbo-browser-panel";

/** What a hidden host holds: browser tabs, or every other kind of tab. */
type HiddenTabKind = "browser" | "other";

const PANEL = `.dv-groupview[${BROWSER_PANEL_ATTRIBUTE}]`;
const NOT_PANEL = `:not([${BROWSER_PANEL_ATTRIBUTE}])`;
// The groups each kind of hidden tab takes its box from, best first.
const GROUPS: Record<HiddenTabKind, readonly string[]> = {
  browser: [PANEL, ".dv-groupview.dv-active-group", ".dv-groupview"],
  other: [
    `.dv-groupview.dv-active-group${NOT_PANEL}`,
    `.dv-groupview${NOT_PANEL}`,
    ".dv-groupview.dv-active-group",
    ".dv-groupview",
  ],
};

function groupContent(
  container: HTMLElement,
  kind: HiddenTabKind,
): HTMLElement | null {
  for (const selector of GROUPS[kind]) {
    const content = container
      .querySelector<HTMLElement>(selector)
      ?.querySelector<HTMLElement>(":scope > .dv-content-container");
    if (content) return content;
  }
  return null;
}

/**
 * Where a panel's content sits inside the dock: the active group's content
 * box (below its tab strip), which is where a new tab lands. In a tidy layout
 * browser tabs land in the browser panel instead, so a hidden browser tab
 * takes that panel's box, and any other hidden tab the box of the group in
 * use, or of another group while the browser panel is the one in use.
 *
 * Tabs that are not visible in the dock render in hidden hosts outside
 * dockview, which used to cover the whole dock area. A browser tab opened
 * behind the visible one was laid out 31 px taller there and shrank when it
 * came forward, so the page moved under an agent that had already measured
 * it. A terminal fitted while hidden (it binds a renderer to parse busy
 * output, or when an agent writes to it) resized its PTY the same way.
 *
 * Fractions rather than pixels: the UI zoom setting scales the app with CSS
 * zoom, so a measured box set back as a pixel style is scaled by the zoom a
 * second time (at 95% a background tab came out 5% too small), while a share
 * of the dock stays the same share at any zoom.
 */
export function dockContentArea(
  container: HTMLElement,
  kind: HiddenTabKind = "other",
): DockArea | null {
  const content = groupContent(container, kind);
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

/** dockContentArea for the element `containerRef` is set on, for both kinds
 *  of hidden tab, kept current as the dock or either content box resizes.
 *  Call `remeasure` whenever the dock's layout changes (a group added or
 *  activated, a space loaded): those resize neither box, and dockview builds
 *  its groups after the dock mounts. A callback ref, because the dock is not
 *  there at all while the first-run page shows. */
export function useDockContentArea(): {
  area: DockArea | null;
  browserArea: DockArea | null;
  containerRef: (container: HTMLElement | null) => (() => void) | undefined;
  remeasure: () => void;
} {
  const [area, setArea] = useState<DockArea | null>(null);
  const [browserArea, setBrowserArea] = useState<DockArea | null>(null);
  const measureRef = useRef<(() => void) | null>(null);
  const containerRef = useCallback((container: HTMLElement | null) => {
    if (!container) return;
    let frame = 0;
    let watched: Element[] = [];
    const observer = new ResizeObserver(() => {
      if (!frame) frame = requestAnimationFrame(measure);
    });
    function measure() {
      frame = 0;
      const dock = container as HTMLElement;
      const next = dockContentArea(dock, "other");
      const nextBrowser = dockContentArea(dock, "browser");
      setArea((current) => (sameArea(current, next) ? current : next));
      setBrowserArea((current) =>
        sameArea(current, nextBrowser) ? current : nextBrowser,
      );
      // Follow the content boxes themselves too: a split's sash moves them
      // without resizing the dock.
      const contents = [
        groupContent(dock, "other"),
        groupContent(dock, "browser"),
      ].filter((content): content is HTMLElement => content !== null);
      for (const content of watched) {
        if (!contents.includes(content as HTMLElement)) {
          observer.unobserve(content);
        }
      }
      for (const content of contents) {
        if (!watched.includes(content)) observer.observe(content);
      }
      watched = contents;
    }
    observer.observe(container);
    measure();
    measureRef.current = measure;
    return () => {
      measureRef.current = null;
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);
  const remeasure = useCallback(() => measureRef.current?.(), []);
  return { area, browserArea, containerRef, remeasure };
}
