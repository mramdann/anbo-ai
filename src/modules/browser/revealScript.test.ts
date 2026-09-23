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
const baselineSource = readFileSync(
  new URL(
    "../../../src-tauri/src/modules/browser_automation/revealBaseline.js",
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
  type?: string;
  className = "";
  /** Text this node holds directly, read back as one text node. */
  text?: string;
  isConnected = true;
  parent: Node | null = null;

  constructor(init: Partial<Node> & { attributes?: Attributes } = {}) {
    Object.assign(this, init);
    this.attributes = init.attributes ?? {};
    this.children = init.children ?? [];
    for (const child of this.children) child.parent = this;
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  get parentElement(): Node | null {
    return this.parent;
  }

  get textContent(): string {
    return [
      this.text ?? "",
      ...this.children.map((child) => child.textContent),
    ].join("");
  }

  contains(other: Node | null): boolean {
    for (let node = other; node; node = node.parent) {
      if (node === this) return true;
    }
    return false;
  }

  closest(selector: string): Node | null {
    const roles = [...selector.matchAll(/\[role="([a-z]+)"\]/g)].map(
      (match) => match[1],
    );
    for (let node: Node | null = this; node; node = node.parent) {
      const role = node.getAttribute("role");
      if (role && roles.includes(role)) return node;
    }
    return null;
  }

  descendants(): Node[] {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }

  // Enough of a matcher for the three selectors reveal.js uses: role lists
  // plus a couple of bare tags.
  querySelectorAll(selector: string): Node[] {
    if (selector === "*") return this.descendants();
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
  duringAction?: () => void;
  activeElement?: Node | null;
  /** The text a type action filled in. */
  query?: string;
  /** What the registry resolves a ref to on a given frame; defaults to the node remembered last. */
  resolve?: (ref: string, frame: number) => Node | null;
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
      activeElement: options.activeElement ?? null,
      querySelectorAll: (selector: string) =>
        options.body.querySelectorAll(selector),
      createTreeWalker: (root: Node) => {
        const texts = [root, ...root.descendants()]
          .filter((node) => node.text !== undefined)
          .map((node) => ({ nodeValue: node.text, parentElement: node }));
        let index = 0;
        return { nextNode: () => texts[index++] ?? null };
      },
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
    NodeFilter: { SHOW_TEXT: 4 },
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
      resolve: (ref: string) => {
        if (options.resolve) return options.resolve(ref, frames);
        for (let index = remembered.length - 1; index >= 0; index--) {
          if (remembered[index][0] === ref) return remembered[index][1];
        }
        return null;
      },
    },
  });
  vm.runInContext(`${baselineSource}\n${revealSource}`, context);
  let before = options.before ?? null;
  if (options.duringAction) {
    Object.assign(context, {
      target: options.target,
      query: options.query ?? null,
    });
    const revealToken = vm.runInContext(
      "captureRevealBaseline(target, query)",
      context,
    ) as number;
    before = { url: page.url, title: page.title, ...{ revealToken } };
    options.duringAction();
  }

  const promise = vm.runInContext(
    `revealAfterAction(target, ${JSON.stringify({
      budgetMs: options.budgetMs ?? 400,
      refPrefix: `g${options.generation ?? 7}-r`,
      limit: 10,
      generation: options.generation ?? 7,
      declaredOnly: options.declaredOnly ?? false,
      before,
      query: options.query ?? null,
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
  it("recognizes an undeclared list opened synchronously by the action", async () => {
    const list = new Node({
      attributes: { role: "listbox" },
      visible: false,
      children: [option("Fresh result")],
    });
    const old = new Node({
      attributes: { role: "menu" },
      children: [option("Unrelated")],
    });
    const target = new Node({ attributes: { role: "combobox" } });
    const result = await run({
      target,
      body: new Node({ children: [target, old, list] }),
      duringAction: () => {
        list.visible = true;
      },
    });
    expect(result.count).toBe(1);
    expect(result.items).toEqual([
      { ref: "g7-r1", role: "option", name: "Fresh result" },
    ]);
  });

  it("resolves a replaced declared surface instead of retaining its old node", async () => {
    const list = new Node({
      attributes: { role: "listbox", id: "suggestions" },
      visible: false,
    });
    const target = new Node({ attributes: { "aria-controls": "suggestions" } });
    const body = new Node({ children: [target, list] });
    const result = await run({
      target,
      body,
      after: {
        frames: 3,
        apply: () => {
          body.children = [
            target,
            new Node({
              attributes: { role: "listbox", id: "suggestions" },
              children: [option("Replacement")],
            }),
          ];
        },
      },
    });
    expect(result.items).toEqual([
      { ref: "g7-r1", role: "option", name: "Replacement" },
    ]);
  });

  it("does not attribute a pre-existing surface to the action", async () => {
    const target = new Node({ attributes: { role: "combobox" } });
    const list = new Node({
      attributes: { role: "listbox" },
      children: [option("Old result")],
    });
    const result = await run({
      target,
      body: new Node({ children: [target, list] }),
      duringAction: () => {},
    });
    expect(result.count).toBe(0);
  });

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

  it("hands back the search field an undeclared click focused, still without a sweep", async () => {
    // TradingView's symbol button declares no popup; its dialog opens with the
    // search field focused, and the caller spent a find to learn its ref.
    let sweeps = 0;
    const field = new Node({
      localName: "input",
      type: "search",
      name: "Symbol, ISIN, or CUSIP",
    });
    const dialog = new Node({
      attributes: { role: "dialog" },
      children: [field],
    });
    const target = new Node({ localName: "button" });
    const body = new Node({ children: [target, dialog] });
    body.querySelectorAll = (selector: string) => {
      sweeps += 1;
      return Node.prototype.querySelectorAll.call(body, selector);
    };

    const result = await run({
      target,
      body,
      declaredOnly: true,
      activeElement: field,
    });
    expect(result.surface).toBe("focus");
    expect(result.items).toEqual([
      { ref: "g7-r1", role: "searchbox", name: "Symbol, ISIN, or CUSIP" },
    ]);
    expect(result.remembered).toEqual([["g7-r1", field]]);
    expect(sweeps).toBe(0);

    // A plain text field in a dialog counts too: the dialog is what opened.
    const plain = new Node({ localName: "input", name: "Title" });
    const edit = await run({
      target,
      body: new Node({
        children: [
          target,
          new Node({ attributes: { role: "dialog" }, children: [plain] }),
        ],
      }),
      declaredOnly: true,
      activeElement: plain,
    });
    expect(edit.items).toEqual([
      { ref: "g7-r1", role: "textbox", name: "Title" },
    ]);
  });

  it("does not report focus that says nothing about what the click opened", async () => {
    const target = new Node({ localName: "button" });
    const outside = new Node({ localName: "input", name: "Email" });
    const checkbox = new Node({ localName: "input", type: "checkbox" });
    const hidden = new Node({
      localName: "input",
      type: "search",
      visible: false,
    });
    new Node({ attributes: { role: "dialog" }, children: [checkbox, hidden] });
    const body = new Node({ children: [target, outside] });
    for (const activeElement of [null, target, outside, checkbox, hidden]) {
      const result = await run({
        target,
        body,
        declaredOnly: true,
        activeElement,
      });
      expect(result.surface).toBeNull();
      expect(result.count).toBe(0);
      expect(result.remembered).toEqual([]);
    }
  });

  it("re-registers a field whose ref went stale while its dialog was still mounting", async () => {
    // v37: every TradingView ref taken on the first frame failed as
    // context_changed on the caller's next call.
    const field = new Node({
      localName: "input",
      type: "search",
      name: "Find",
    });
    const target = new Node({ localName: "button" });
    const result = await run({
      target,
      body: new Node({ children: [target, field] }),
      declaredOnly: true,
      activeElement: field,
      resolve: (_ref, frame) => (frame === 1 ? null : field),
    });
    expect(result.items).toEqual([
      { ref: "g7-r1", role: "searchbox", name: "Find" },
    ]);
    expect(result.remembered).toEqual([
      ["g7-r1", field],
      ["g7-r1", field],
    ]);
  });

  it("hands back nothing when the focused field never settles", async () => {
    const field = new Node({
      localName: "input",
      type: "search",
      name: "Find",
    });
    const target = new Node({ localName: "button" });
    const result = await run({
      target,
      body: new Node({ children: [target, field] }),
      declaredOnly: true,
      activeElement: field,
      resolve: () => null,
    });
    expect(result.ok).toBe(true);
    expect(result.surface).toBeNull();
    expect(result.count).toBe(0);
  });

  it("reads the new rows that carry the typed text inside the dialog the field sits in", async () => {
    // TradingView: the symbol search dialog is already open, and its results
    // are plain repeated divs with no role, so no surface ever opens.
    const row = (name: string, symbol: string) =>
      new Node({
        className: "itemRow",
        name,
        children: [
          new Node({ localName: "span", text: symbol.slice(0, 1) }),
          new Node({ localName: "em", text: symbol }),
        ],
      });
    const field = new Node({ localName: "input", type: "search" });
    // A default row that already matched before the fill is not an answer.
    const list = new Node({
      className: "list",
      children: [
        row("E ETHUSDT (recent)", "ETHUSDT"),
        row("B BTCUSDT", "BTCUSDT"),
      ],
    });
    const dialog = new Node({
      attributes: { role: "dialog" },
      children: [field, list],
    });
    const fresh = [
      row("E ETHUSDT Ethereum / TetherUS Binance", "ETHUSDT"),
      row("E ETHUSDT Bybit", "ETHUSDT"),
      row("S SOLUSDT", "SOLUSDT"),
    ];
    const result = await run({
      target: field,
      body: new Node({ children: [dialog] }),
      query: "ethusdt",
      duringAction: () => {
        list.children = fresh;
        for (const item of fresh) item.parent = list;
      },
    });
    expect(result.surface).toBe("results");
    expect(result.items).toEqual([
      {
        ref: "g7-r1",
        role: "option",
        name: "E ETHUSDT Ethereum / TetherUS Binance",
      },
      { ref: "g7-r2", role: "option", name: "E ETHUSDT Bybit" },
    ]);
  });

  it("points a row laid out with display: contents at its rendered part", async () => {
    // TradingView: the list item itself has no box; its symbol column does,
    // and a click there bubbles to the row. The item keeps the row name.
    const row = (name: string, symbol: string) =>
      new Node({
        className: "itemRow",
        name,
        visible: false,
        children: [
          new Node({ localName: "span", visible: false }),
          new Node({
            className: "symbol",
            name: symbol,
            children: [new Node({ localName: "em", text: symbol })],
          }),
        ],
      });
    const field = new Node({ localName: "input", type: "search" });
    const list = new Node({ className: "list", children: [] });
    const dialog = new Node({
      attributes: { role: "dialog" },
      children: [field, list],
    });
    const fresh = [
      row("E ETHUSDT Ethereum / TetherUS Binance", "ETHUSDT"),
      row("E ETHUSDT Bybit", "ETHUSDT"),
    ];
    const result = await run({
      target: field,
      body: new Node({ children: [dialog] }),
      query: "ethusdt",
      duringAction: () => {
        list.children = fresh;
        for (const item of fresh) item.parent = list;
      },
    });
    expect(result.items).toEqual([
      {
        ref: "g7-r1",
        role: "option",
        name: "E ETHUSDT Ethereum / TetherUS Binance",
      },
      { ref: "g7-r2", role: "option", name: "E ETHUSDT Bybit" },
    ]);
    expect((result.remembered as Array<[string, Node]>)[0][1]).toBe(
      fresh[0].children[1],
    );
  });

  it("does not answer a fill with rows the dialog already showed", async () => {
    const row = (symbol: string) =>
      new Node({
        className: "itemRow",
        name: symbol,
        children: [
          new Node({ localName: "span", text: "E" }),
          new Node({ localName: "em", text: symbol }),
        ],
      });
    const field = new Node({ localName: "input", type: "search" });
    const dialog = new Node({
      attributes: { role: "dialog" },
      children: [
        field,
        new Node({
          className: "list",
          children: [row("ETHUSDT"), row("ETHBTC")],
        }),
      ],
    });
    const result = await run({
      target: field,
      body: new Node({ children: [dialog] }),
      query: "ethusdt",
      duringAction: () => {},
    });
    expect(result.count).toBe(0);
    expect(result.surface).toBeNull();
  });

  it("keeps the reply when the focused field cannot be registered", async () => {
    const field = new Node({
      localName: "input",
      type: "search",
      name: "Find",
    });
    const target = new Node({ localName: "button" });
    const result = await run({
      target,
      body: new Node({ children: [target, field] }),
      declaredOnly: true,
      activeElement: field,
      registryThrows: true,
    });
    expect(result.ok).toBe(true);
    expect(result.surface).toBeNull();
    expect(result.count).toBe(0);
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
