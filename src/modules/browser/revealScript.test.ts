import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const revealSource = readFileSync(
  new URL(
    "../../../src-tauri/src/modules/browser_automation/reveal.js",
    import.meta.url,
  ),
  "utf8",
);

type Attributes = Record<string, string>;

class Node {
  attributes: Attributes = {};
  children: Node[] = [];
  visible = true;
  localName = "div";
  name = "";

  constructor(init: Partial<Node> & { attributes?: Attributes } = {}) {
    Object.assign(this, init);
    this.attributes = init.attributes ?? {};
    this.children = init.children ?? [];
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  descendants(): Node[] {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }

  // Enough of a matcher for the three selectors reveal.js uses: role lists
  // plus a couple of bare tags.
  querySelectorAll(selector: string): Node[] {
    const roles = [...selector.matchAll(/\[role="([a-z]+)"\]/g)].map(
      (match) => match[1],
    );
    const tags = selector
      .split(",")
      .map((part) => part.trim())
      .filter((part) => /^[a-z]+(\[[a-z]+\])?$/.test(part))
      .map((part) => part.replace(/\[.*\]$/, ""));
    return this.descendants().filter((node) => {
      const role = node.getAttribute("role");
      return (role && roles.includes(role)) || tags.includes(node.localName);
    });
  }
}

function option(name: string, attributes: Attributes = {}): Node {
  return new Node({
    localName: "li",
    name,
    attributes: { role: "option", ...attributes },
  });
}

function run(options: {
  target: Node;
  body: Node;
  budgetMs?: number;
  generation?: number;
  before?: { url: string; title: string } | null;
  url?: string;
  title?: string;
  /** Mutate the page after this many animation frames. */
  after?: {
    frames: number;
    apply: (page: { url: string; title: string }) => void;
  };
  registryThrows?: boolean;
  declaredOnly?: boolean;
}): Promise<Record<string, unknown>> {
  const remembered: Array<[string, Node]> = [];
  let frames = 0;
  // A fake clock: animation frames run in order, and the budget expiring is
  // what ends the wait, exactly as it does in the browser.
  const frameQueue: Array<() => void> = [];
  const expire: Array<() => void> = [];
  const page = {
    url: options.url ?? "https://example.test/",
    title: options.title ?? "Example",
  };

  const context = vm.createContext({
    isRenderedElement: (node: Node) => !!node && node.visible,
    accessibleName: (node: Node) => node.name,
    document: {
      get title() {
        return page.title;
      },
      documentElement: { scrollHeight: 1000 },
      querySelectorAll: (selector: string) =>
        options.body.querySelectorAll(selector),
      getElementById: (id: string) =>
        options.body.descendants().find((node) => node.attributes.id === id) ??
        null,
    },
    location: {
      get href() {
        return page.url;
      },
    },
    Date,
    requestAnimationFrame: (callback: () => void) => {
      frameQueue.push(callback);
      return frameQueue.length;
    },
    cancelAnimationFrame: () => {},
    setTimeout: (callback: () => void) => {
      expire.push(callback);
      return 0;
    },
    clearTimeout: () => {
      expire.length = 0;
    },
    refRegistry: {
      begin: () => {
        if (options.registryThrows) throw new Error("stale_scan");
      },
      remember: (ref: string, node: Node) => remembered.push([ref, node]),
    },
  });
  vm.runInContext(revealSource, context);

  const promise = vm.runInContext(
    `revealAfterAction(target, ${JSON.stringify({
      budgetMs: options.budgetMs ?? 400,
      refPrefix: `g${options.generation ?? 7}-r`,
      limit: 10,
      generation: options.generation ?? 7,
      declaredOnly: options.declaredOnly ?? false,
      before: options.before ?? null,
    })}, refRegistry)`,
    Object.assign(context, { target: options.target }),
  ) as Promise<string>;

  const MAX_FRAMES = 24;
  while (frameQueue.length && frames < MAX_FRAMES) {
    const next = frameQueue.shift();
    frames += 1;
    if (options.after && frames === options.after.frames)
      options.after.apply(page);
    next?.();
  }
  expire[0]?.();

  return promise.then((raw) => {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return { ...parsed, remembered };
  });
}

describe("revealAfterAction", () => {
  it("hands back the declared listbox's options as refs", async () => {
    const list = new Node({
      attributes: { role: "listbox", id: "suggestions" },
      children: [option("Zürich, Switzerland"), option("Zurich Airport")],
    });
    const target = new Node({
      localName: "input",
      attributes: { role: "combobox", "aria-controls": "suggestions" },
    });
    const body = new Node({ children: [target, list] });

    const result = await run({ target, body });
    expect(result.surface).toBe("listbox");
    expect(result.count).toBe(2);
    expect(result.items).toEqual([
      { ref: "g7-r1", role: "option", name: "Zürich, Switzerland" },
      { ref: "g7-r2", role: "option", name: "Zurich Airport" },
    ]);
    expect(result.remembered).toHaveLength(2);
  });

  it("waits for suggestions that arrive a few frames late", async () => {
    const list = new Node({
      attributes: { role: "listbox", id: "suggestions" },
      children: [],
    });
    const target = new Node({
      attributes: { role: "combobox", "aria-controls": "suggestions" },
    });
    const body = new Node({ children: [target, list] });

    const result = await run({
      target,
      body,
      after: { frames: 3, apply: () => list.children.push(option("London")) },
    });
    expect(result.surface).toBe("listbox");
    expect(result.count).toBe(1);
  });

  it("waits out a list that answers twice before handing back refs", async () => {
    // A suggestion list that re-renders on a second response detaches every
    // node it just showed; a ref taken from the first answer is dead on
    // arrival.
    const list = new Node({
      attributes: { role: "listbox", id: "suggestions" },
      children: [option("stale one"), option("stale two")],
    });
    const target = new Node({
      attributes: { role: "combobox", "aria-controls": "suggestions" },
    });
    const body = new Node({ children: [target, list] });

    const result = await run({
      target,
      body,
      after: {
        frames: 2,
        apply: () => {
          list.children = [option("fresh one"), option("fresh two")];
        },
      },
    });
    expect(result.count).toBe(2);
    expect(
      (result.items as Array<{ name: string }>).map((item) => item.name),
    ).toEqual(["fresh one", "fresh two"]);
  });

  it("a click on a control that declares nothing never sweeps the document", async () => {
    // Ten sessions of the heavy suite opened no undeclared menu, so the sweep
    // was paid for by every click and repaid none of them.
    let sweeps = 0;
    const menu = new Node({
      attributes: { role: "menu" },
      children: [option("Sort by date", { role: "menuitem" })],
    });
    const target = new Node({ localName: "button" });
    const body = new Node({ children: [target, menu] });
    const counted = new Node({ children: body.children });
    counted.querySelectorAll = (selector: string) => {
      sweeps += 1;
      return Node.prototype.querySelectorAll.call(counted, selector);
    };

    const result = await run({ target, body: counted, declaredOnly: true });
    expect(result.surface).toBeNull();
    expect(sweeps).toBe(0);

    // The same button, now declaring a popup, still has to see the menu
    // arrive: a surface already on screen was not opened by this click.
    const declaring = new Node({
      localName: "button",
      attributes: { "aria-haspopup": "true" },
    });
    const late = new Node({
      attributes: { role: "menu" },
      visible: false,
      children: [option("Sort by date", { role: "menuitem" })],
    });
    const opened = await run({
      target: declaring,
      body: new Node({ children: [declaring, late] }),
      declaredOnly: true,
      after: {
        frames: 2,
        apply: () => {
          late.visible = true;
        },
      },
    });
    expect(opened.surface).toBe("menu");
    expect(opened.count).toBe(1);
  });

  it("reports nothing rather than guessing when nothing opens", async () => {
    const target = new Node({ attributes: { role: "combobox" } });
    const body = new Node({ children: [target] });
    const result = await run({ target, body });
    expect(result.surface).toBeNull();
    expect(result.count).toBe(0);
    expect(result.items).toEqual([]);
    expect(result.remembered).toHaveLength(0);
  });

  it("does not claim a surface that was already open before the action", async () => {
    // Nothing declares this menu, and it was on screen when the click landed,
    // so attributing it to the click would be an invention.
    const menu = new Node({
      attributes: { role: "menu" },
      children: [option("Already there", { role: "menuitem" })],
    });
    const target = new Node({ localName: "button" });
    const body = new Node({ children: [target, menu] });

    const result = await run({ target, body });
    expect(result.surface).toBeNull();
    expect(result.count).toBe(0);
  });

  it("claims an undeclared menu that became visible during the action", async () => {
    const menu = new Node({
      attributes: { role: "menu" },
      visible: false,
      children: [option("Sort by date", { role: "menuitem" })],
    });
    const target = new Node({ localName: "button" });
    const body = new Node({ children: [target, menu] });

    const result = await run({
      target,
      body,
      after: {
        frames: 2,
        apply: () => {
          menu.visible = true;
        },
      },
    });
    expect(result.surface).toBe("menu");
    expect(result.count).toBe(1);
  });

  it("reports a dialog that opened and the url the action moved to", async () => {
    const dialog = new Node({
      attributes: { role: "dialog" },
      visible: false,
      children: [],
    });
    const target = new Node({ localName: "button" });
    const body = new Node({ children: [target, dialog] });

    const result = await run({
      target,
      body,
      before: { url: "https://example.test/", title: "Example" },
      after: {
        frames: 2,
        apply: (page) => {
          dialog.visible = true;
          page.url = "https://example.test/checkout";
        },
      },
    });
    const observed = result.observed as Record<string, unknown>;
    expect(result.surface).toBe("dialog");
    expect(observed.dialogOpened).toBe(true);
    expect(observed.urlChanged).toBe("https://example.test/checkout");
  });

  it("gives the reply back even when another scan took the generation", async () => {
    const list = new Node({
      attributes: { role: "listbox", id: "suggestions" },
      children: [option("Paris")],
    });
    const target = new Node({
      attributes: { role: "combobox", "aria-controls": "suggestions" },
    });
    const body = new Node({ children: [target, list] });

    const result = await run({ target, body, registryThrows: true });
    expect(result.ok).toBe(true);
    expect(result.count).toBe(0);
    expect(result.items).toEqual([]);
  });
});
