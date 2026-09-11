import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const read = (name: string) =>
  readFileSync(
    new URL(
      `../../../../src-tauri/src/modules/browser_automation/${name}`,
      import.meta.url,
    ),
    "utf8",
  );
const LAYER = read("designLayer.js");
const ACCESSIBLE = read("accessibleName.js");
const visibilitySource = read("visibility.rs");
const VISIBILITY = visibilitySource.slice(
  visibilitySource.indexOf('r#"') + 3,
  visibilitySource.lastIndexOf('"#'),
);

type Rect = { left: number; top: number; width: number; height: number };
type Listener = (event: unknown) => void;

// biome-ignore lint/suspicious/noExplicitAny: a hand-built DOM stand-in
type Any = any;

class FakeStyle {
  [key: string]: Any;
  setProperty(name: string, value: string) {
    this[name] = value;
  }
  removeProperty(name: string) {
    delete this[name];
  }
  set cssText(text: string) {
    for (const part of text.split(";")) {
      const [name, value] = part.split(":");
      if (name && value)
        this[name.trim()] = value.replace("!important", "").trim();
    }
  }
}

class FakeNode {
  nodeType = 1;
  children: FakeNode[] = [];
  parentNode: FakeNode | FakeShadowRoot | null = null;
  listeners = new Map<string, Listener[]>();
  addEventListener(type: string, fn: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  removeEventListener(type: string, fn: Listener) {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((it) => it !== fn),
    );
  }
  fire(type: string, event: Any) {
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }
  get childNodes() {
    return this.children;
  }
  get firstChild() {
    return this.children[0] ?? null;
  }
  get lastChild() {
    return this.children[this.children.length - 1] ?? null;
  }
  append(...nodes: FakeNode[]) {
    for (const node of nodes) {
      node.remove();
      node.parentNode = this as Any;
      this.children.push(node);
    }
  }
  insertBefore(node: FakeNode, reference: FakeNode | null) {
    node.remove();
    node.parentNode = this as Any;
    const index = reference ? this.children.indexOf(reference) : -1;
    if (index < 0) this.children.push(node);
    else this.children.splice(index, 0, node);
  }
  replaceChildren(...nodes: FakeNode[]) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this.append(...nodes);
  }
  remove() {
    const parent = this.parentNode as Any;
    if (parent)
      parent.children = parent.children.filter((c: Any) => c !== this);
    this.parentNode = null;
  }
}

class FakeText extends FakeNode {
  nodeType = 3;
  textContent: string;
  constructor(text: string) {
    super();
    this.textContent = text;
  }
}

class FakeShadowRoot extends FakeNode {
  nodeType = 11;
  host: FakeElement;
  constructor(host: FakeElement) {
    super();
    this.host = host;
  }
  get isConnected() {
    return this.host.isConnected;
  }
  getRootNode() {
    return this;
  }
  querySelectorAll(selector: string) {
    return query(this.children, selector);
  }
  querySelector(selector: string) {
    return query(this.children, selector)[0] ?? null;
  }
}

let doc: FakeDocument;

class FakeElement extends FakeNode {
  tagName: string;
  attributes = new Map<string, string>();
  style = new FakeStyle();
  shadow: FakeShadowRoot | null = null;
  value = "";
  offsetHeight = 100;
  checkVisibility() {
    return true;
  }
  constructor(tag: string, upper = true) {
    super();
    this.tagName = upper ? tag.toUpperCase() : tag;
  }
  get id() {
    return this.attributes.get("id") ?? "";
  }
  get className() {
    return this.attributes.get("class") ?? "";
  }
  set className(value: string) {
    this.attributes.set("class", value);
  }
  get classList() {
    const list = () => this.className.split(/\s+/).filter(Boolean);
    return {
      contains: (name: string) => list().includes(name),
      add: (name: string) => {
        if (!list().includes(name))
          this.className = [...list(), name].join(" ");
      },
      remove: (name: string) => {
        this.className = list()
          .filter((it) => it !== name)
          .join(" ");
      },
      toggle(name: string, force?: boolean) {
        const on = force ?? !list().includes(name);
        if (on) this.add(name);
        else this.remove(name);
        return on;
      },
    };
  }
  get parentElement(): FakeElement | null {
    return this.parentNode instanceof FakeElement ? this.parentNode : null;
  }
  get isConnected(): boolean {
    let node: Any = this;
    while (node) {
      if (node === doc.documentElement) return true;
      node = node instanceof FakeShadowRoot ? node.host : node.parentNode;
    }
    return false;
  }
  getRootNode(): Any {
    let node: Any = this;
    while (node.parentNode) node = node.parentNode;
    return node instanceof FakeShadowRoot
      ? node
      : node === doc.documentElement
        ? doc
        : node;
  }
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, String(value));
  }
  hasAttribute(name: string) {
    return this.attributes.has(name);
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
  get type() {
    return this.attributes.get("type") ?? undefined;
  }
  get hidden() {
    return false;
  }
  get isContentEditable() {
    return false;
  }
  get textContent(): string {
    return this.children
      .map((c) =>
        c instanceof FakeText ? c.textContent : (c as FakeElement).textContent,
      )
      .join("");
  }
  set textContent(value: string) {
    this.replaceChildren(new FakeText(value));
  }
  get innerText() {
    return this.textContent;
  }
  attachShadow() {
    this.shadow = new FakeShadowRoot(this);
    shadowRoots.push(this.shadow);
    return this.shadow;
  }
  get shadowRoot() {
    return null;
  }
  getBoundingClientRect() {
    const rect = rects.get(this) ?? { left: 0, top: 0, width: 0, height: 0 };
    return {
      ...rect,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
      x: rect.left,
      y: rect.top,
    };
  }
  getClientRects() {
    return [this.getBoundingClientRect()];
  }
  setPointerCapture() {}
  releasePointerCapture() {}
  focus() {
    doc.activeElement = this;
  }
  blur() {
    doc.activeElement = doc.body;
  }
  querySelectorAll(selector: string) {
    return query(this.children, selector);
  }
  querySelector(selector: string) {
    return query(this.children, selector)[0] ?? null;
  }
}

function descendants(nodes: FakeNode[]): FakeElement[] {
  const out: FakeElement[] = [];
  const walk = (list: FakeNode[]) => {
    for (const node of list) {
      if (node instanceof FakeElement) {
        out.push(node);
        walk(node.children);
      }
    }
  };
  walk(nodes);
  return out;
}

function matchesCompound(el: FakeElement, compound: string): boolean {
  let rest = compound;
  const tagMatch = rest.match(/^[a-zA-Z][\w-]*/);
  if (tagMatch) {
    if (el.tagName.toLowerCase() !== tagMatch[0].toLowerCase()) return false;
    rest = rest.slice(tagMatch[0].length);
  }
  while (rest) {
    const id = rest.match(/^#([\w\\-]+)/);
    if (id) {
      if (el.id !== id[1].replace(/\\(.)/g, "$1")) return false;
      rest = rest.slice(id[0].length);
      continue;
    }
    const attr = rest.match(/^\[([\w-]+)="((?:[^"\\]|\\.)*)"\]/);
    if (attr) {
      if (el.getAttribute(attr[1]) !== attr[2].replace(/\\(.)/g, "$1"))
        return false;
      rest = rest.slice(attr[0].length);
      continue;
    }
    const nth = rest.match(/^:nth-of-type\((\d+)\)/);
    if (nth) {
      const parent = el.parentNode as Any;
      const siblings = (parent?.children ?? []).filter(
        (c: Any) => c instanceof FakeElement && c.tagName === el.tagName,
      );
      if (siblings.indexOf(el) + 1 !== Number(nth[1])) return false;
      rest = rest.slice(nth[0].length);
      continue;
    }
    throw new Error(`unsupported selector piece: ${rest}`);
  }
  return true;
}

function query(scope: FakeNode[], selector: string): FakeElement[] {
  const compounds = selector.split(" > ").map((part) => part.trim());
  return descendants(scope).filter((el) => {
    let node: FakeElement | null = el;
    for (let index = compounds.length - 1; index >= 0; index -= 1) {
      if (!node || !matchesCompound(node, compounds[index])) return false;
      node = node.parentElement;
    }
    return true;
  });
}

class FakeDocument {
  documentElement: FakeElement;
  body: FakeElement;
  title = "Settings";
  fullscreenElement: FakeElement | null = null;
  hidden = false;
  activeElement: FakeElement;
  listeners = new Map<string, Listener[]>();
  nodeType = 9;
  constructor() {
    this.documentElement = new FakeElement("html");
    this.body = new FakeElement("body");
    this.documentElement.append(this.body);
    this.activeElement = this.body;
  }
  createElement(tag: string) {
    return new FakeElement(tag);
  }
  createElementNS(_ns: string, tag: string) {
    return new FakeElement(tag, false);
  }
  addEventListener(type: string, fn: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  removeEventListener(type: string, fn: Listener) {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((it) => it !== fn),
    );
  }
  fire(type: string, event: Any = {}) {
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }
  querySelectorAll(selector: string) {
    return query([this.body], selector);
  }
  querySelector(selector: string) {
    return query([this.body], selector)[0] ?? null;
  }
  getElementById(id: string) {
    return descendants([this.body]).find((el) => el.id === id) ?? null;
  }
  elementsFromPoint(x: number, y: number) {
    const stack: FakeElement[] = [];
    const host = this.documentElement.children.find(
      (c) => c instanceof FakeElement && c.tagName === "ANBO-DESIGN-LAYER",
    ) as FakeElement | undefined;
    if (host && host.style["pointer-events"] !== "none") stack.push(host);
    const hits = descendants([this.body])
      .filter((el) => {
        const r = rects.get(el);
        return (
          r &&
          x >= r.left &&
          x <= r.left + r.width &&
          y >= r.top &&
          y <= r.top + r.height
        );
      })
      .map((el) => {
        let depth = 0;
        for (let node: Any = el; node; node = node.parentNode) depth += 1;
        return { el, depth };
      })
      .sort((a, b) => b.depth - a.depth)
      .map((it) => it.el);
    return [...stack, ...hits, this.body, this.documentElement];
  }
}

const rects = new Map<FakeElement, Rect>();
const shadowRoots: FakeShadowRoot[] = [];

function el(
  tag: string,
  attrs: Record<string, string> = {},
  text?: string,
  rect?: Rect,
) {
  const node = new FakeElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text !== undefined) node.append(new FakeText(text));
  if (rect) rects.set(node, rect);
  return node;
}

function page() {
  rects.clear();
  shadowRoots.length = 0;
  doc = new FakeDocument();
  rects.set(doc.documentElement, {
    left: 0,
    top: 0,
    width: 1200,
    height: 3000,
  });
  rects.set(doc.body, { left: 0, top: 0, width: 1200, height: 3000 });
  const main = el("main", { id: "app" }, undefined, {
    left: 0,
    top: 0,
    width: 1200,
    height: 3000,
  });
  const h1 = el("h1", {}, "Settings", {
    left: 40,
    top: 20,
    width: 300,
    height: 40,
  });
  const form = el("form", {}, undefined, {
    left: 40,
    top: 80,
    width: 600,
    height: 200,
  });
  const label = el("label", { for: "name" }, "Name", {
    left: 40,
    top: 80,
    width: 100,
    height: 20,
  });
  const input = el(
    "input",
    { id: "name", type: "text", placeholder: "Your name" },
    undefined,
    { left: 40, top: 100, width: 300, height: 32 },
  );
  const save = el(
    "button",
    { id: "save", "data-testid": "save" },
    "Save changes",
    { left: 40, top: 150, width: 140, height: 36 },
  );
  form.append(label, input, save);
  const section = el("section", { "aria-label": "Filters" }, undefined, {
    left: 40,
    top: 300,
    width: 600,
    height: 300,
  });
  const first = el("div", { class: "card" }, undefined, {
    left: 40,
    top: 300,
    width: 600,
    height: 100,
  });
  first.append(
    el("p", {}, "First", { left: 48, top: 308, width: 300, height: 20 }),
  );
  const second = el("div", { class: "card" }, undefined, {
    left: 40,
    top: 410,
    width: 600,
    height: 100,
  });
  const secondText = el("p", {}, "Second", {
    left: 48,
    top: 418,
    width: 300,
    height: 20,
  });
  second.append(secondText);
  section.append(first, second);
  main.append(h1, form, section);
  doc.body.append(main);
  return { main, h1, form, input, save, section, first, second, secondText };
}

function harness() {
  const nodes = page();
  const posted: Any[] = [];
  const windowListeners = new Map<string, Listener[]>();
  let now = 0;
  let nextTimer = 1;
  let timers: { id: number; at: number; run: () => void }[] = [];
  let frames: { id: number; run: () => void }[] = [];
  const sandbox: Any = {
    innerWidth: 1200,
    innerHeight: 800,
    scrollX: 0,
    scrollY: 0,
    devicePixelRatio: 2,
    location: { href: "http://localhost:5173/settings#top" },
    document: doc,
    console,
    WeakRef: (globalThis as Any).WeakRef,
    CSS: { escape: (value: string) => value.replace(/([^\w-])/g, "\\$1") },
    getComputedStyle: () => ({
      display: "block",
      visibility: "visible",
      opacity: "1",
    }),
    addEventListener: (type: string, fn: Listener) => {
      windowListeners.set(type, [...(windowListeners.get(type) ?? []), fn]);
    },
    removeEventListener: (type: string, fn: Listener) => {
      windowListeners.set(
        type,
        (windowListeners.get(type) ?? []).filter((it) => it !== fn),
      );
    },
    requestAnimationFrame: (run: () => void) => {
      const id = nextTimer++;
      frames.push({ id, run });
      return id;
    },
    cancelAnimationFrame: (id: number) => {
      frames = frames.filter((frame) => frame.id !== id);
    },
    setTimeout: (run: () => void, ms: number) => {
      const id = nextTimer++;
      timers.push({ id, at: now + (ms || 0), run });
      return id;
    },
    clearTimeout: (id: number) => {
      timers = timers.filter((timer) => timer.id !== id);
    },
    __anboDesignPost: (json: string) => {
      posted.push(JSON.parse(json));
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  const install = (
    init: Record<string, unknown> = { tool: "box", model: null },
  ) =>
    vm.runInContext(
      `(() => {\n${ACCESSIBLE}\n${VISIBILITY}\n${LAYER}\nreturn globalThis.__anboDesign.configure(${JSON.stringify(init)});\n})()`,
      context,
    );
  const api = () => sandbox.__anboDesign;
  const flushFrames = () => {
    while (frames.length) {
      const batch = frames;
      frames = [];
      for (const frame of batch) frame.run();
    }
  };
  const advance = (ms: number) => {
    now += ms;
    let due = timers
      .filter((timer) => timer.at <= now)
      .sort((a, b) => a.at - b.at);
    while (due.length) {
      timers = timers.filter((timer) => !due.includes(timer));
      for (const timer of due) timer.run();
      due = timers
        .filter((timer) => timer.at <= now)
        .sort((a, b) => a.at - b.at);
    }
    flushFrames();
  };
  const host = () =>
    doc.documentElement.children.find(
      (c) => c instanceof FakeElement && c.tagName === "ANBO-DESIGN-LAYER",
    ) as FakeElement | undefined;
  const root = () => shadowRoots[shadowRoots.length - 1];
  const part = (className: string) =>
    descendants(root().children).find(
      (it) =>
        it.className === className ||
        it.className.split(" ").includes(className),
    ) as FakeElement;
  const canvas = () => part("canvas");
  const svg = () => part("marks");
  const note = () => part("note");
  const noteInput = () =>
    note().children.find(
      (c) => (c as FakeElement).tagName === "TEXTAREA",
    ) as FakeElement;
  const marks = () => svg().children[0].children as FakeElement[];
  const pointer = (
    type: string,
    x: number,
    y: number,
    extra: Record<string, unknown> = {},
  ) => {
    const event: Any = {
      type,
      isTrusted: true,
      button: 0,
      pointerId: 1,
      clientX: x,
      clientY: y,
      target: canvas(),
      preventDefault() {},
      stopPropagation() {},
      ...extra,
    };
    event.getCoalescedEvents ??= () => [event];
    canvas().fire(type, event);
    return event;
  };
  const drag = (x1: number, y1: number, x2: number, y2: number) => {
    pointer("pointerdown", x1, y1);
    pointer("pointermove", (x1 + x2) / 2, (y1 + y2) / 2);
    flushFrames();
    pointer("pointermove", x2, y2);
    flushFrames();
    pointer("pointerup", x2, y2);
  };
  const click = (x: number, y: number) => {
    pointer("pointerdown", x, y);
    pointer("pointerup", x, y);
  };
  const key = (key: string, extra: Record<string, unknown> = {}) => {
    const event: Any = {
      type: "keydown",
      isTrusted: true,
      key,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      target: doc.body,
      defaulted: false,
      preventDefault() {
        this.defaulted = true;
      },
      stopPropagation() {},
      ...extra,
    };
    for (const fn of windowListeners.get("keydown") ?? []) fn(event);
    return event;
  };
  const fireWindow = (type: string, event: Any = {}) => {
    for (const fn of windowListeners.get(type) ?? []) fn(event);
  };
  return {
    nodes,
    sandbox,
    posted,
    install,
    api,
    advance,
    flushFrames,
    host,
    root,
    part,
    canvas,
    svg,
    note,
    noteInput,
    marks,
    pointer,
    drag,
    click,
    key,
    fireWindow,
    windowListeners,
  };
}

describe("design layer script", () => {
  it("installs once inside a closed shadow root and reports its status", () => {
    const h = harness();
    const status = h.install({ tool: "pen", model: null });
    expect(status).toMatchObject({
      ok: true,
      tool: "pen",
      marks: 0,
      dirty: false,
    });
    const host = h.host();
    expect(host).toBeDefined();
    expect(host?.getAttribute("aria-hidden")).toBe("true");
    expect(host?.getAttribute("data-tool")).toBe("pen");
    expect(host?.style["pointer-events"]).toBe("auto");
    expect(host?.style["z-index"]).toBe("2147483646");
    expect(h.root().children.map((c) => (c as FakeElement).tagName)).toContain(
      "STYLE",
    );
    expect(h.install({ tool: "box" })).toMatchObject({ ok: true, tool: "box" });
    expect(h.host()).toBe(host);
  });

  it("turns a drag into a numbered box with the element under it and opens the note", () => {
    const h = harness();
    h.install();
    h.drag(60, 130, 160, 190);
    expect(h.marks()).toHaveLength(1);
    const mark = h.api().export().marks[0];
    expect(mark).toMatchObject({
      n: 1,
      kind: "box",
      anchored: false,
      rect: { x: 60, y: 130, width: 100, height: 60 },
      viewport: { x: 60, y: 130, width: 100, height: 60 },
      inViewport: true,
    });
    expect(mark.element).toMatchObject({
      tag: "button",
      name: "Save changes",
      selector: "#save",
      locator: { by: "testId", value: "save" },
    });
    expect(h.note().style.display).toBe("block");
    expect(doc.activeElement).toBe(h.noteInput());
    expect(
      (h.marks()[0].children[1].children[1] as FakeElement).textContent,
    ).toBe("1");
    h.advance(200);
    expect(h.posted[h.posted.length - 1]).toMatchObject({
      type: "state",
      marks: 1,
      dirty: true,
      tool: "box",
    });
    h.advance(800);
    const model = h.posted[h.posted.length - 1];
    expect(model.type).toBe("model");
    expect(model.url).toBe("http://localhost:5173/settings#top");
    expect(model.model.marks).toHaveLength(1);
  });

  it("marks a clicked element as an anchored box that follows layout", () => {
    const h = harness();
    h.install();
    h.click(60, 160);
    const mark = h.api().export().marks[0];
    expect(mark).toMatchObject({
      kind: "box",
      anchored: true,
      rect: { x: 40, y: 150, width: 140, height: 36 },
    });
    rects.set(h.nodes.save, { left: 40, top: 500, width: 140, height: 36 });
    h.fireWindow("resize");
    h.flushFrames();
    expect(h.api().export().marks[0].rect).toMatchObject({ y: 500 });
  });

  it("only hints a role locator that browser_find can resolve", () => {
    const h = harness();
    h.install({ tool: "pick", model: null });
    h.click(100, 40);
    const heading = h.api().export().marks[0].element;
    expect(heading).toMatchObject({
      tag: "h1",
      role: "heading",
      name: "Settings",
    });
    expect(heading.locator).toEqual({ by: "text", value: "Settings" });
    h.nodes.section.setAttribute("role", "region");
    h.click(600, 550);
    const region = h.api().export().marks[1].element;
    expect(region.locator).toEqual({
      by: "role",
      value: "region",
      name: "Filters",
    });
  });

  it("keeps a sketch bounded and ignores clicks that never moved", () => {
    const h = harness();
    h.install({ tool: "pen", model: null });
    h.click(10, 10);
    expect(h.marks()).toHaveLength(0);
    h.pointer("pointerdown", 10, 10);
    for (let index = 1; index <= 3000; index += 1) {
      h.pointer("pointermove", 10 + index, 10 + (index % 7));
    }
    h.flushFrames();
    h.pointer("pointerup", 3010, 12);
    const mark = h.api().export().marks[0];
    expect(mark.kind).toBe("pen");
    expect(mark.points.length).toBeLessThanOrEqual(512);
    expect(mark.points[0]).toEqual([10, 10]);
    expect(mark.points[mark.points.length - 1]).toEqual([3010, 14]);
    expect(mark.rect.width).toBeGreaterThan(2900);
  });

  it("aims an arrow at the element under its head", () => {
    const h = harness();
    h.install({ tool: "arrow", model: null });
    h.drag(500, 50, 60, 320);
    const mark = h.api().export().marks[0];
    expect(mark.kind).toBe("arrow");
    expect(mark.points).toEqual([
      [500, 50],
      [60, 320],
    ]);
    expect(mark.element).toMatchObject({ tag: "p", text: "First" });
    // The shortest path that is unique in the document, not the full one.
    expect(mark.element.selector).toBe("div:nth-of-type(1) > p");
    expect(mark.element.locator).toEqual({ by: "text", value: "First" });
  });

  it("ignores untrusted input and input aimed at editable page fields", () => {
    const h = harness();
    h.install();
    h.pointer("pointerdown", 100, 100, { isTrusted: false });
    h.pointer("pointerup", 200, 200, { isTrusted: false });
    expect(h.marks()).toHaveLength(0);
    h.key("p", { isTrusted: false });
    expect(h.api().status().tool).toBe("box");
    h.key("p", { target: h.nodes.input });
    expect(h.api().status().tool).toBe("box");
    const handled = h.key("p");
    expect(handled.defaulted).toBe(true);
    expect(h.api().status().tool).toBe("pen");
    for (const [letter, tool] of [
      ["a", "arrow"],
      ["i", "pick"],
      ["v", "hand"],
      ["b", "box"],
    ]) {
      h.key(letter);
      expect(h.api().status().tool).toBe(tool);
    }
    h.key("v");
    expect(h.host()?.style["pointer-events"]).toBe("none");
  });

  it("saves the note on Enter, deletes with Delete, undoes with Ctrl+Z and exits with Escape", () => {
    const h = harness();
    h.install();
    h.drag(100, 100, 300, 190);
    h.noteInput().value = "  Too much padding\r\nhere  ";
    const enter: Any = {
      isTrusted: true,
      key: "Enter",
      shiftKey: false,
      preventDefault() {},
      stopPropagation() {},
    };
    h.noteInput().fire("keydown", enter);
    expect(h.note().style.display).toBe("none");
    expect(h.api().export().marks[0].note).toBe("Too much padding\nhere");
    h.drag(400, 400, 500, 450);
    expect(h.api().status().marks).toBe(2);
    h.key("Delete");
    expect(h.api().status().marks).toBe(1);
    expect(h.api().export().marks[0].n).toBe(1);
    h.key("z", { ctrlKey: true });
    expect(h.api().status().marks).toBe(2);
    expect(
      h
        .api()
        .export()
        .marks.map((m: Any) => m.n),
    ).toEqual([1, 2]);
    h.key("Escape");
    expect(h.api().status().selected).toBeNull();
    const before = h.posted.length;
    h.key("Escape");
    expect(
      h.posted.slice(before).some((message) => message.type === "exit"),
    ).toBe(true);
    const noteEscape = h.key("Escape", { target: h.host() });
    expect(noteEscape.defaulted).toBe(false);
  });

  it("keeps marks in document coordinates while the page scrolls", () => {
    const h = harness();
    h.install();
    h.sandbox.scrollY = 300;
    doc.fire("scroll");
    h.flushFrames();
    expect((h.svg().children[0] as FakeElement).getAttribute("transform")).toBe(
      "translate(0,-300)",
    );
    h.drag(50, 50, 150, 100);
    const mark = h.api().export().marks[0];
    expect(mark.rect).toMatchObject({ x: 50, y: 350 });
    expect(mark.viewport).toMatchObject({ x: 50, y: 50 });
    expect(mark.inViewport).toBe(true);
    h.sandbox.scrollY = 2000;
    doc.fire("scroll");
    h.flushFrames();
    expect(h.api().export().marks[0].inViewport).toBe(false);
  });

  it("switches presentation for captures and agent screenshots", () => {
    const h = harness();
    h.install();
    h.drag(100, 100, 300, 190);
    expect(h.api().present("capture")).toBe(true);
    expect(h.host()?.getAttribute("data-presentation")).toBe("capture");
    expect(h.note().style.display).toBe("none");
    expect(h.host()?.style.display).toBe("block");
    expect(h.api().present("hidden")).toBe(true);
    expect(h.host()?.style.display).toBe("none");
    expect(h.api().present("normal")).toBe(true);
    expect(h.host()?.style.display).toBe("block");
    expect(h.host()?.getAttribute("data-presentation")).toBe("normal");
  });

  it("answers commands and refuses unknown ones", () => {
    const h = harness();
    h.install();
    h.drag(100, 100, 300, 190);
    h.drag(400, 400, 500, 450);
    expect(h.api().command("clear")).toMatchObject({ ok: true, marks: 0 });
    expect(h.marks()).toHaveLength(0);
    expect(h.api().command("undo")).toMatchObject({ ok: true, marks: 2 });
    expect(h.marks()).toHaveLength(2);
    expect(h.api().command("tool:hand")).toMatchObject({
      ok: true,
      tool: "hand",
    });
    expect(h.api().command("tool:laser")).toMatchObject({ ok: false });
    expect(h.api().command("teleport")).toMatchObject({ ok: false });
    expect(h.api().command("flush").ok).toBe(true);
    expect(h.posted[h.posted.length - 1].type).toBe("model");
  });

  it("stops at the mark limit and says so", () => {
    const h = harness();
    h.install();
    for (let index = 0; index < 101; index += 1) {
      const x = 10 + (index % 40) * 20;
      const y = 10 + Math.floor(index / 40) * 20;
      h.drag(x, y, x + 10, y + 10);
    }
    const status = h.api().status();
    expect(status.marks).toBe(100);
    expect(status.limit).toMatch(/100 marks/);
  });

  it("restores a saved model, re-anchoring element marks by selector", () => {
    const h = harness();
    const model = {
      marks: [
        {
          n: 1,
          kind: "box",
          note: "tighter",
          anchored: true,
          rect: { x: 1, y: 1, width: 5, height: 5 },
          element: { selector: "#save", inShadow: false },
        },
        {
          n: 2,
          kind: "pen",
          note: "",
          points: [
            [1, 1],
            [50, 60],
          ],
          rect: { x: 1, y: 1, width: 49, height: 59 },
        },
        {
          n: 3,
          kind: "arrow",
          note: "",
          points: [[1, 1]],
          rect: { x: 1, y: 1, width: 0, height: 0 },
        },
        {
          n: 4,
          kind: "hand",
          note: "",
          rect: { x: 1, y: 1, width: 5, height: 5 },
        },
      ],
    };
    expect(h.install({ tool: "pick", model })).toMatchObject({
      ok: true,
      tool: "pick",
      marks: 3,
      dirty: false,
    });
    h.flushFrames();
    const restored = h.api().export().marks;
    expect(restored[0]).toMatchObject({
      kind: "box",
      note: "tighter",
      rect: { x: 40, y: 150, width: 140, height: 36 },
    });
    expect(restored[1]).toMatchObject({
      kind: "pen",
      points: [
        [1, 1],
        [50, 60],
      ],
    });
    expect(restored[2]).toMatchObject({ kind: "box", n: 3 });
  });

  it("flushes the model on pagehide and leaves nothing behind on uninstall", () => {
    const h = harness();
    h.install();
    h.drag(100, 100, 300, 190);
    h.fireWindow("pagehide");
    expect(h.posted[h.posted.length - 1]).toMatchObject({ type: "model" });
    expect(h.posted[h.posted.length - 1].model.marks).toHaveLength(1);
    const before = h.posted.length;
    expect(h.api().uninstall()).toBe(true);
    expect(h.posted.length).toBe(before + 1);
    expect(h.host()).toBeUndefined();
    expect(h.sandbox.__anboDesign).toBeUndefined();
    expect((h.windowListeners.get("keydown") ?? []).length).toBe(0);
    expect((doc.listeners.get("scroll") ?? []).length).toBe(0);
  });

  it("drops coalesced samples that an earlier event already delivered", () => {
    const h = harness();
    h.install({ tool: "pen", model: null });
    h.pointer("pointerdown", 10, 10, { timeStamp: 0 });
    const move = (samples: [number, number, number][]) => {
      const [x, y] = samples[samples.length - 1];
      h.pointer("pointermove", x, y, {
        timeStamp: samples[samples.length - 1][2],
        getCoalescedEvents: () =>
          samples.map(([sx, sy, stamp]) => ({
            clientX: sx,
            clientY: sy,
            timeStamp: stamp,
          })),
      });
    };
    move([
      [20, 10, 10],
      [30, 10, 20],
    ]);
    move([
      [30, 10, 20],
      [40, 10, 30],
    ]);
    h.flushFrames();
    h.pointer("pointerup", 40, 10, { timeStamp: 40 });
    expect(h.api().export().marks[0].points).toEqual([
      [10, 10],
      [20, 10],
      [30, 10],
      [40, 10],
    ]);
  });

  it("paints its chrome with the app theme and drops anything that is not a colour", () => {
    const h = harness();
    h.install({
      tool: "box",
      model: null,
      theme: {
        mode: "light",
        surface: "oklch(1 0 0)",
        text: "#1b2330",
        border: "oklch(0.925 0.005 214.3)",
        accent: "red; color: blue",
        field: "url(x)}",
        bogus: "#fff",
      },
    });
    const host = h.host();
    expect(host?.getAttribute("data-mode")).toBe("light");
    expect(host?.style["color-scheme"]).toBe("light");
    expect(host?.style["--anbo-design-surface"]).toBe("oklch(1 0 0)");
    expect(host?.style["--anbo-design-text"]).toBe("#1b2330");
    expect(host?.style["--anbo-design-border"]).toBe(
      "oklch(0.925 0.005 214.3)",
    );
    expect(host?.style["--anbo-design-accent"]).toBeUndefined();
    expect(host?.style["--anbo-design-field"]).toBeUndefined();
    expect(host?.style["--anbo-design-bogus"]).toBeUndefined();
    // A later theme with fewer colours falls back to the mode defaults.
    h.api().configure({ theme: { mode: "dark", text: "#e4f2f5" } });
    expect(host?.getAttribute("data-mode")).toBe("dark");
    expect(host?.style["--anbo-design-surface"]).toBeUndefined();
    expect(host?.style["--anbo-design-text"]).toBe("#e4f2f5");
    expect(h.api().status().marks).toBe(0);
  });

  it("is skipped by the page scanners", () => {
    for (const file of [
      "accessibleName.js",
      "readable_text.rs",
      "locator.rs",
    ]) {
      expect(read(file)).toContain("ANBO-DESIGN-LAYER");
    }
    expect(read("design.rs")).toContain('include_str!("designLayer.js")');
  });
});
