import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL(
    "../../../src-tauri/src/modules/browser_automation/linkGuard.js",
    import.meta.url,
  ),
  "utf8",
);

type Click = {
  currentTarget: FakeNode | null;
  defaultPrevented: boolean;
  cancelBubble: boolean;
  preventDefault: () => void;
  stopPropagation: () => void;
  composedPath: () => FakeNode[];
};

class FakeNode {
  parentNode: FakeNode | null = null;
  // A handler the page set before the guard came, so it runs first.
  pageHandler?: (event: Click) => void;
  readonly holds = new Set<(event: Click) => void>();

  addEventListener(_type: string, hold: (event: Click) => void) {
    this.holds.add(hold);
  }

  removeEventListener(_type: string, hold: (event: Click) => void) {
    this.holds.delete(hold);
  }
}

class FakeAnchor extends FakeNode {
  relList: { contains: (value: string) => boolean };
  protocol: string;

  constructor(
    public href = "https://example.com/next",
    private readonly attributes: Record<string, string> = {},
  ) {
    super();
    this.protocol = `${href.split(":")[0]}:`;
    const rel = (attributes.rel ?? "").split(/\s+/);
    this.relList = { contains: (value) => rel.includes(value) };
  }

  closest() {
    return this;
  }

  hasAttribute(name: string) {
    return name in this.attributes;
  }
}

function page() {
  const expired: (() => void)[] = [];
  const window = new FakeNode() as FakeNode & {
    __anboHeldLink?: {
      held: { url: string | null; pageTookIt: boolean; stoodDown: boolean };
      disarm: () => void;
    };
  };
  const row = new FakeNode();
  const guard = vm.runInNewContext(`${source}\nanboGuardLink`, {
    window,
    HTMLAnchorElement: FakeAnchor,
    setTimeout: (run: () => void) => expired.push(run),
    clearTimeout: () => {},
  }) as (node: object, opensTab: (link: object) => boolean) => boolean;
  const link = (anchor = new FakeAnchor()) => {
    anchor.parentNode = row;
    return anchor;
  };
  const click = (target: FakeNode) => {
    const path = [target];
    for (let at = target.parentNode; at; at = at.parentNode) path.push(at);
    path.push(window);
    const event: Click = {
      currentTarget: null,
      defaultPrevented: false,
      cancelBubble: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {
        this.cancelBubble = true;
      },
      composedPath: () => path,
    };
    for (const node of path) {
      event.currentTarget = node;
      node.pageHandler?.(event);
      for (const hold of [...node.holds]) hold(event);
      if (event.cancelBubble) break;
    }
    return event;
  };
  return {
    guard,
    click,
    link,
    row,
    expire: () => {
      for (const run of expired) run();
    },
    held: () => window.__anboHeldLink?.held,
    listeners: () => window.holds.size + row.holds.size,
  };
}

const everyLink = () => true;

describe("link guard", () => {
  it("keeps the browser from following the link and notes where it went", () => {
    const { guard, click, link, held } = page();
    const anchor = link();
    expect(guard(anchor, everyLink)).toBe(true);
    expect(click(anchor).defaultPrevented).toBe(true);
    expect(held()).toMatchObject({
      url: "https://example.com/next",
      pageTookIt: false,
      stoodDown: false,
    });
  });

  it("comes after every handler on the way up, which may rewrite the address", () => {
    const { guard, click, link, row, held } = page();
    const anchor = link();
    guard(anchor, everyLink);
    row.pageHandler = () => {
      anchor.href = "https://example.com/rewritten";
    };
    click(anchor);
    expect(held()?.url).toBe("https://example.com/rewritten");
  });

  it("leaves a click the page took to the page", () => {
    const { guard, click, link, held } = page();
    const anchor = link();
    anchor.pageHandler = (event) => event.preventDefault();
    guard(anchor, everyLink);
    click(anchor);
    expect(held()).toMatchObject({ url: null, pageTookIt: true });
  });

  it("holds a click a handler kept from going further up", () => {
    // A link in a clickable row: its handler keeps the row from seeing the click.
    const { guard, click, link, row, held } = page();
    const anchor = link();
    anchor.pageHandler = (event) => event.stopPropagation();
    guard(anchor, everyLink);
    expect(click(anchor).defaultPrevented).toBe(true);
    expect(held()?.url).toBe("https://example.com/next");

    const again = page();
    const other = again.link();
    again.row.pageHandler = (event) => event.stopPropagation();
    again.guard(other, everyLink);
    expect(again.click(other).defaultPrevented).toBe(true);
    expect(row.holds.size).toBe(0);
  });

  it("guards only a web link that opens a tab and needs no opener", () => {
    const { guard, link } = page();
    const skipped = [
      new FakeAnchor("mailto:someone@example.com"),
      new FakeAnchor("blob:https://example.com/1"),
      new FakeAnchor(undefined, { download: "" }),
      new FakeAnchor(undefined, { rel: "noreferrer opener" }),
    ];
    for (const anchor of skipped) expect(guard(anchor, everyLink)).toBe(false);
    expect(guard(link(), () => false)).toBe(false);
    expect(guard({ closest: () => null }, everyLink)).toBe(false);
    expect(guard({}, everyLink)).toBe(false);
    // An SVG link matches a[href] too, and has no address to read like this.
    expect(guard({ closest: () => ({}) }, everyLink)).toBe(false);
  });

  it("lets a click elsewhere on the page through and stays armed", () => {
    const { guard, click, link, held } = page();
    const anchor = link();
    guard(anchor, everyLink);
    expect(click(link()).defaultPrevented).toBe(false);
    expect(held()?.url).toBeNull();
    expect(click(anchor).defaultPrevented).toBe(true);
  });

  it("stands down by itself, so a later click is the user's", () => {
    const { guard, click, link, expire, held, listeners } = page();
    const anchor = link();
    guard(anchor, everyLink);
    expire();
    expect(listeners()).toBe(0);
    expect(click(anchor).defaultPrevented).toBe(false);
    expect(held()?.url).toBeNull();
    // For the log: a click that came after says the guard had stood down.
    expect(held()?.stoodDown).toBe(true);
  });

  it("holds one click only", () => {
    const { guard, click, link } = page();
    const anchor = link();
    guard(anchor, everyLink);
    click(anchor);
    expect(click(anchor).defaultPrevented).toBe(false);
  });

  it("retires the guard before it, which would read the next click as the page's", () => {
    const { guard, click, link, held } = page();
    const anchor = link();
    guard(anchor, everyLink);
    guard(anchor, everyLink);
    click(anchor);
    expect(held()).toMatchObject({
      url: "https://example.com/next",
      pageTookIt: false,
      stoodDown: false,
    });
  });
});
