import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL(
    "../../../src-tauri/src/modules/browser_automation/activityOverlay.js",
    import.meta.url,
  ),
  "utf8",
);

const VIEWPORT = { width: 1200, height: 800 };

// biome-ignore lint/suspicious/noExplicitAny: a hand-built DOM stand-in
type El = any;

function element(tag: string): El {
  const node: El = {
    tag,
    className: "",
    textContent: "",
    dataset: {} as Record<string, string>,
    attributes: new Map<string, string>(),
    children: [] as El[],
    parentNode: null as El | null,
    isConnected: false,
    offsetWidth: 200,
    offsetHeight: 44,
    get childNodes() {
      return node.children;
    },
    append(...kids: El[]) {
      for (const kid of kids) {
        kid.parentNode = node;
        kid.isConnected = node.isConnected;
        node.children.push(kid);
      }
    },
    replaceChildren(...kids: El[]) {
      node.children = [];
      node.append(...kids);
    },
    setAttribute(name: string, value: string) {
      node.attributes.set(name, value);
    },
    getAttribute(name: string) {
      return node.attributes.get(name) ?? null;
    },
    toggleAttribute(name: string, force?: boolean) {
      const on = force ?? !node.attributes.has(name);
      if (on) node.attributes.set(name, "");
      else node.attributes.delete(name);
      return on;
    },
    remove() {
      node.isConnected = false;
      const parent = node.parentNode;
      if (parent)
        parent.children = parent.children.filter((kid: El) => kid !== node);
      node.parentNode = null;
    },
    getBoundingClientRect: () => ({
      width: VIEWPORT.width,
      height: VIEWPORT.height,
    }),
    animated: [] as { frames: unknown; timing: Record<string, unknown> }[],
    animate(frames: unknown, timing: Record<string, unknown>) {
      node.animated.push({ frames, timing });
      return { currentTime: 0, cancel() {}, pause() {}, play() {} };
    },
    cloneNode: () => element(tag),
    replaceWith(next: El) {
      const parent = node.parentNode;
      if (!parent) return;
      parent.children = parent.children.map((kid: El) =>
        kid === node ? next : kid,
      );
      next.parentNode = parent;
      next.isConnected = parent.isConnected;
    },
    querySelectorAll(selector: string) {
      const wanted = selector.replace(/^\./, "");
      const found: El[] = [];
      const walk = (from: El) => {
        for (const kid of from.children) {
          if (kid.className.split(" ").includes(wanted)) found.push(kid);
          walk(kid);
        }
      };
      walk(node);
      return found;
    },
    attachShadow() {
      // Kept in children so the walk below reaches it. A closed root is not
      // reachable this way in a browser, which is the point of using one.
      const root = element("#shadow-root");
      root.isConnected = true;
      node.append(root);
      return root;
    },
  };
  node.style = {
    setProperty(name: string, value: string) {
      node.style[name] = value;
    },
  };
  return node;
}

// `sized` makes the stand-in ResizeObserver report the viewport and the badge
// as a browser does on observe; only then are the orbs set on their way.
function overlay({ reducedMotion = false, sized = false } = {}) {
  const documentElement = element("html");
  documentElement.isConnected = true;
  const windowListeners = new Map<string, ((event: El) => void)[]>();
  const listen =
    (map: Map<string, ((event: El) => void)[]>) =>
    (type: string, handler: (event: El) => void) => {
      map.set(type, [...(map.get(type) ?? []), handler]);
    };

  let clock = 0;
  let nextTimer = 1;
  let timers: { id: number; at: number; run: () => void }[] = [];
  let frames: (() => void)[] = [];
  const styles: string[] = [];

  const context: El = {
    innerWidth: VIEWPORT.width,
    innerHeight: VIEWPORT.height,
    setTimeout(run: () => void, delay = 0) {
      const id = nextTimer++;
      timers.push({ id, at: clock + delay, run });
      return id;
    },
    clearTimeout(id: number) {
      timers = timers.filter((timer) => timer.id !== id);
    },
    requestAnimationFrame(run: () => void) {
      frames.push(run);
      return frames.length;
    },
    cancelAnimationFrame() {},
    matchMedia: () => ({
      matches: reducedMotion,
      addEventListener() {},
      removeEventListener() {},
    }),
    CSSStyleSheet: class {
      replaceSync(text: string) {
        styles.push(text);
      }
    },
    ResizeObserver: class {
      private readonly report: (entries: El[]) => void;
      constructor(report: (entries: El[]) => void) {
        this.report = report;
      }
      observe(target: El) {
        if (!sized) return;
        this.report([
          {
            target,
            contentRect: VIEWPORT,
            borderBoxSize: [{ inlineSize: 200, blockSize: 44 }],
          },
        ]);
      }
      disconnect() {}
    },
    document: {
      hidden: false,
      documentElement,
      fullscreenElement: null,
      createElement: element,
      createElementNS: (_ns: string, tag: string) => element(tag),
      addEventListener: listen(new Map()),
    },
  };
  context.window = context;
  context.addEventListener = listen(windowListeners);
  vm.runInNewContext(source, context);

  const find = (className: string): El =>
    documentElement.querySelectorAll(`.${className}`)[0];

  return {
    send(detail: Record<string, unknown>) {
      for (const handler of windowListeners.get("anbo-automation-visual") ?? [])
        handler({ detail });
      const queued = frames;
      frames = [];
      for (const run of queued) run();
    },
    advance(ms: number) {
      const until = clock + ms;
      for (;;) {
        const due = timers
          .filter((timer) => timer.at <= until)
          .sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers = timers.filter((timer) => timer !== due);
        clock = due.at;
        due.run();
      }
      clock = until;
    },
    get mounted() {
      return documentElement.children.length > 0;
    },
    cursor: () => find("cursor"),
    detail: () => find("detail"),
    name: () => find("name"),
    tool: () => find("tool"),
    // data-idle is what tells the stylesheet the session is held rather than
    // working, so it is the switch the breathing halo hangs off.
    held: () => documentElement.children[0]?.attributes.has("data-idle"),
    // What each orb was told when its travel round the page's edge was set up.
    orbs: (): { timing: Record<string, unknown> }[] =>
      documentElement
        .querySelectorAll(".orb")
        .map((orb: El) => orb.animated.at(-1)),
    styles: () => styles.join(String.fromCharCode(10)),
  };
}

const actor = { brand: "claude", label: "Claude" };
const event = (extra: Record<string, unknown>) => ({
  tabId: 1,
  controlId: 7,
  requestId: 1,
  actor,
  method: "click",
  ...extra,
});

describe("browser automation presence overlay", () => {
  it("shows a cursor for a live session even when the action carries no point", () => {
    // A navigation drops the stored point and rebuilds the page's script from
    // nothing, so an action without coordinates used to leave the tab holding a
    // badge and no pointer at all. A held session always has a cursor.
    const view = overlay();
    view.send(event({ sequence: 1, phase: "done", method: "get_text" }));
    expect(view.cursor().style.display).toBe("block");
    expect(view.cursor().style.transform).toBe("translate(600px,400px)");
  });

  it("parks at the point the agent acted on and stays there", () => {
    // Motion is reserved for work. The cursor holds the last action point for
    // as long as the session lives, so movement always means something
    // happened rather than being decoration that runs on its own.
    const view = overlay();
    view.send(
      event({ sequence: 1, phase: "click", point: { x: 420, y: 310 } }),
    );
    view.send(event({ sequence: 2, phase: "done", point: { x: 420, y: 310 } }));
    expect(view.cursor().style.transform).toBe("translate(420px,310px)");

    view.advance(60_000);
    expect(view.cursor().style.transform).toBe("translate(420px,310px)");
    expect(view.detail().textContent).toBe("");
    expect(view.name().textContent).toBe("Claude");
    expect(view.tool().textContent).toBe("browser_click");
  });

  it("hides completed detail without hiding the cursor or subsequent progress and errors", () => {
    const view = overlay();
    view.send(
      event({ sequence: 1, phase: "running", point: { x: 420, y: 310 } }),
    );
    expect(view.detail().textContent).toContain("Clicking");
    view.send(event({ sequence: 2, phase: "done" }));
    expect(view.detail().textContent).toBe("");
    expect(view.styles()).toContain(".detail:empty{display:none}");
    expect(view.cursor().style.display).toBe("block");
    expect(view.cursor().style.transform).toBe("translate(420px,310px)");
    expect(view.name().textContent).toBe("Claude");
    view.send(
      event({
        sequence: 3,
        requestId: 2,
        phase: "running",
        method: "get_text",
      }),
    );
    expect(view.detail().textContent).toContain("Reading the page");
    view.send(
      event({ sequence: 4, requestId: 2, phase: "error", method: "get_text" }),
    );
    expect(view.detail().textContent).toContain("Action stopped");
  });

  it("marks the session held between calls so the halo can breathe", () => {
    // A parked cursor on its own reads as something left behind. data-idle is
    // the switch that separates "holding this tab" from "working right now".
    const view = overlay();
    view.send(
      event({ sequence: 1, phase: "running", point: { x: 10, y: 20 } }),
    );
    expect(view.held()).toBe(false);

    view.send(event({ sequence: 2, phase: "done", point: { x: 10, y: 20 } }));
    expect(view.held()).toBe(true);

    view.send(
      event({ sequence: 3, phase: "running", point: { x: 30, y: 40 } }),
    );
    expect(view.held()).toBe(false);
  });

  it("breathes only while held, and holds still under reduced motion", () => {
    const view = overlay();
    // The stylesheet is built with the overlay, on the first paint.
    view.send(event({ sequence: 1, phase: "done", point: { x: 10, y: 20 } }));
    const css = view.styles();
    expect(css).toMatch(/:host\(\[data-idle\]\) \.hold\{animation:hold /);
    // Transform and opacity only: the halo must stay a compositor job, because
    // it runs for as long as the agent holds the tab.
    expect(css).toMatch(/@keyframes hold\{[^}]*opacity:[^}]*transform:scale/);
    expect(css).toMatch(
      /prefers-reduced-motion:reduce\)\{[^@]*\.hold\{animation:none/,
    );
  });

  it("draws the halo's breath at thirty-six moments, each as the smooth breath stands there", () => {
    // An animation that runs keeps its page drawing at the display's rate for
    // as long as an agent holds the tab: on a machine that draws without a
    // graphics card the smooth halo took 9% of a core (round 112). So its
    // keyframes are the breath's own values at 36 evenly spaced moments, each
    // held until the next. The curve here is the design: faint and small at
    // both ends, full in the middle, ease-in-out up and down.
    const view = overlay();
    view.send(event({ sequence: 1, phase: "done", point: { x: 10, y: 20 } }));
    const css = view.styles();
    expect(css).toContain(
      ":host([data-idle]) .hold{animation:hold 2800ms step-end infinite}",
    );
    const breath =
      /@keyframes hold\{((?:[^{}]*\{[^{}]*\})*)\}/.exec(css)?.[1] ?? "";
    const frames = [
      ...breath.matchAll(
        /([\d.]+)%\{opacity:([\d.]+);transform:scale\(([\d.]+)\)\}/g,
      ),
    ].map((match) => match.slice(1).map(Number));
    expect(frames).toHaveLength(37);
    // CSS ease-in-out, cubic-bezier(.42, 0, .58, 1), solved for its input.
    const easeInOut = (x: number) => {
      let low = 0;
      let high = 1;
      let t = x;
      for (let turn = 0; turn < 60; turn += 1) {
        if (((0.52 * t - 0.78) * t + 1.26) * t < x) low = t;
        else high = t;
        t = (low + high) / 2;
      }
      return (3 - 2 * t) * t * t;
    };
    frames.forEach(([at, opacity, scale], step) => {
      const t = step / 36;
      const risen = t < 0.5 ? easeInOut(t * 2) : 1 - easeInOut(t * 2 - 1);
      expect(at).toBeCloseTo(t * 100, 3);
      expect(opacity).toBeCloseTo(0.14 + 0.76 * risen, 3);
      expect(scale).toBeCloseTo(0.72 + 0.28 * risen, 3);
    });
    expect(frames[0].slice(1)).toEqual([0.14, 0.72]);
    expect(frames[18].slice(1)).toEqual([0.9, 1]);
    expect(frames[36].slice(1)).toEqual([0.14, 0.72]);
  });

  it("moves one orb per frame: thirty positions a second each, half a step apart", () => {
    // The two orbs run at opposite edges. Moving in the same frame they made
    // the whole page the area to draw again, at the display's rate: 29% of a
    // core on a machine that draws without a graphics card (round 112). With
    // 270 positions over the nine-second loop, and the second orb half a
    // position behind the first, each frame changes a patch around one orb.
    const view = overlay({ sized: true });
    view.send(
      event({ sequence: 1, phase: "running", point: { x: 10, y: 20 } }),
    );
    const [first, second] = view.orbs().map((orb) => orb.timing);
    for (const timing of [first, second]) {
      expect(timing).toMatchObject({
        duration: 9000,
        iterations: Number.POSITIVE_INFINITY,
        easing: "steps(270)",
      });
    }
    const step = 9000 / 270;
    expect(first.delay).toBe(0);
    expect(second.delay).toBeCloseTo(-4500 - step / 2, 6);
    // Still opposite each other, to within that half step.
    expect(Math.abs((second.delay as number) + 4500)).toBeLessThan(step);
  });

  it("takes the cursor away when the session ends, and keeps it away", () => {
    const view = overlay();
    view.send(event({ sequence: 1, phase: "done", point: { x: 420, y: 310 } }));
    expect(view.mounted).toBe(true);

    view.send(event({ sequence: 2, phase: "ended" }));
    expect(view.mounted).toBe(false);
    view.advance(60_000);
    expect(view.mounted).toBe(false);
  });
});
