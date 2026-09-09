import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const script = readFileSync(
  new URL(
    "../../../src-tauri/src/modules/browser_automation/refRegistry.js",
    import.meta.url,
  ),
  "utf8",
);

function fixture() {
  const document = { baseURI: "https://fixture.test/results" };
  const context = vm.createContext({ document, URL });
  const run = (body: string, args: Record<string, unknown> = {}) => {
    Object.assign(context, args);
    return vm.runInContext(`(() => {${script};${body}})()`, context);
  };
  const node = (localName = "button") => ({
    localName,
    namespaceURI: "http://www.w3.org/1999/xhtml",
    ownerDocument: document as object,
    baseURI: document.baseURI,
    parentElement: null as object | null,
    assignedSlot: null as object | null,
    shadowHost: null as object | null,
    firstElementChild: null as object | null,
    nextElementSibling: null as object | null,
    previousElementSibling: null as object | null,
    isConnected: true,
    attributes: new Map<string, string>(),
    setAttribute(key: string, value: string) {
      this.attributes.set(key, value);
    },
    getAttribute(key: string) {
      return this.attributes.get(key) ?? null;
    },
    getAttributeNS(_namespace: string, key: string) {
      return this.getAttribute(`xlink:${key}`);
    },
    getRootNode() {
      return { host: this.shadowHost };
    },
    removeAttribute(key: string) {
      this.attributes.delete(key);
    },
  });
  return { run, node };
}

describe("shipped isolated ref registry", () => {
  it("resolves only the original node, not cloned or duplicate attributes", () => {
    const f = fixture();
    const original = f.node();
    f.run("refRegistry.begin(1);refRegistry.remember('g1-e1', original)", {
      original,
    });
    const clone = { ...original, attributes: new Map(original.attributes) };
    expect(f.run("return refRegistry.resolve('g1-e1')", { clone })).toBe(
      original,
    );
    original.isConnected = false;
    expect(f.run("return refRegistry.resolve('g1-e1')")).toBeNull();
  });
  it("rejects detached or adopted nodes while allowing connected node updates", () => {
    const f = fixture();
    const target = f.node();
    f.run("refRegistry.begin(2);refRegistry.remember('g2-e1', target)", {
      target,
    });
    target.setAttribute("title", "Changed text");
    expect(f.run("return refRegistry.resolve('g2-e1')")).toBe(target);
    target.ownerDocument = {};
    expect(f.run("return refRegistry.resolve('g2-e1')")).toBeNull();
  });
  it("replaces a generation and rejects late scans before touching current refs", () => {
    const f = fixture();
    const target = f.node();
    f.run("refRegistry.begin(1);refRegistry.remember('g1-e1', target)", {
      target,
    });
    f.run("refRegistry.begin(2)");
    expect(target.attributes.size).toBe(0);
    expect(f.run("return refRegistry.resolve('g1-e1')")).toBeNull();
    f.run("refRegistry.remember('g2-e1', target)");
    expect(() => f.run("refRegistry.begin(1)")).toThrow("stale_scan");
    expect(f.run("return refRegistry.resolve('g2-e1')")).toBe(target);
  });
  it("caps retained weak references at the snapshot limit", () => {
    const f = fixture();
    const nodes = Array.from({ length: 1001 }, () => f.node());
    f.run(
      "refRegistry.begin(1);nodes.slice(0,1000).forEach((node,i)=>refRegistry.remember('g1-e'+i,node))",
      { nodes },
    );
    expect(() =>
      f.run("refRegistry.remember('g1-e1000', nodes[1000])"),
    ).toThrow("ref_limit");
    f.run("refRegistry.begin(2);refRegistry.remember('g2-e1', nodes[1000])");
    expect(f.run("return refRegistry.resolve('g2-e1')")).toBe(nodes[1000]);
  });
  it("does not share a registry across execution worlds", () => {
    const first = fixture();
    const second = fixture();
    first.run("refRegistry.begin(1);refRegistry.remember('g1-e1', target)", {
      target: first.node(),
    });
    expect(second.run("return refRegistry.resolve('g1-e1')")).toBeNull();
  });

  it.each(["a", "area"])("rejects a reused %s with a changed href", (tag) => {
    const f = fixture();
    const target = f.node(tag);
    target.setAttribute("href", "/watch?v=one");
    f.run("refRegistry.begin(1);refRegistry.remember('g1-e1', target)", {
      target,
    });
    target.setAttribute("href", "/watch?v=two");
    expect(f.run("return refRegistry.resolve('g1-e1')")).toBeNull();
    target.setAttribute("href", "/watch?v=one");
    expect(f.run("return refRegistry.resolve('g1-e1')")).toBeNull();
    f.run("refRegistry.begin(2);refRegistry.remember('g2-e1', target)");
    expect(f.run("return refRegistry.resolve('g2-e1')")).toBe(target);
  });

  it.each(["add", "remove", "fragment", "base", "invalid"])(
    "guards %s destination changes",
    (mode) => {
      const f = fixture();
      const target = f.node("a");
      if (mode !== "add")
        target.setAttribute(
          "href",
          mode === "invalid" ? "http://[invalid" : "relative",
        );
      f.run("refRegistry.begin(1);refRegistry.remember('g1-e1', target)", {
        target,
      });
      if (mode === "remove") target.removeAttribute("href");
      else if (mode === "base")
        target.baseURI = "https://fixture.test/another/";
      else
        target.setAttribute(
          "href",
          mode === "fragment" ? "relative#second" : "/other",
        );
      expect(f.run("return refRegistry.resolve('g1-e1')")).toBeNull();
    },
  );

  it.each(["parentElement", "assignedSlot", "shadowHost"] as const)(
    "guards link descendants through %s",
    (parentKey) => {
      const f = fixture();
      const anchor = f.node("a"),
        target = f.node("span");
      anchor.setAttribute("href", "/first");
      target[parentKey] = anchor;
      f.run("refRegistry.begin(1);refRegistry.remember('g1-e1', target)", {
        target,
      });
      expect(f.run("return refRegistry.resolve('g1-e1')")).toBe(target);
      anchor.setAttribute("href", "/second");
      expect(f.run("return refRegistry.resolve('g1-e1')")).toBeNull();
    },
  );

  it("preserves equivalent resolved URLs and dynamic labels", () => {
    const f = fixture();
    const target = f.node("a");
    target.setAttribute("href", "/watch?v=one");
    f.run("refRegistry.begin(1);refRegistry.remember('g1-e1', target)", {
      target,
    });
    target.setAttribute("href", "https://fixture.test/watch?v=one");
    target.setAttribute("aria-label", "Clock 00:02");
    expect(f.run("return refRegistry.resolve('g1-e1')")).toBe(target);
  });

  it("preserves clock, toggle and input updates without a link IPC guard", () => {
    const f = fixture();
    for (const tag of ["span", "button", "input"]) {
      const target = f.node(tag);
      f.run("refRegistry.begin(1);refRegistry.remember('g1-e1', target)", {
        target,
      });
      Object.assign(target, { textContent: "00:02", value: "updated" });
      target.setAttribute("aria-label", "Pause");
      expect(f.run("return refRegistry.resolve('g1-e1')")).toBe(target);
      expect(f.run("return refRegistry.hasDestination('g1-e1')")).toBe(false);
    }
  });

  it("rechecks native clicks for links even before href is set", () => {
    const f = fixture();
    const target = f.node("a");
    f.run("refRegistry.begin(1);refRegistry.remember('g1-e1', target)", {
      target,
    });
    expect(f.run("return refRegistry.hasDestination('g1-e1')")).toBe(true);
    target.setAttribute("href", "/added-on-hover");
    expect(f.run("return refRegistry.resolve('g1-e1')")).toBeNull();
  });

  it("guards SVG xlink URLs and href precedence", () => {
    const f = fixture();
    const target = f.node("a");
    target.namespaceURI = "http://www.w3.org/2000/svg";
    target.setAttribute("xlink:href", "/first");
    f.run("refRegistry.begin(1);refRegistry.remember('g1-e1', target)", {
      target,
    });
    target.setAttribute("href", "/first");
    expect(f.run("return refRegistry.resolve('g1-e1')")).toBe(target);
    target.setAttribute("xlink:href", "/ignored");
    expect(f.run("return refRegistry.resolve('g1-e1')")).toBe(target);
    target.removeAttribute("href");
    expect(f.run("return refRegistry.resolve('g1-e1')")).toBeNull();
  });

  it("bounds destination storage without truncation collisions", () => {
    const f = fixture();
    const target = f.node("a");
    target.setAttribute("href", `https://fixture.test/${"x".repeat(8192)}`);
    f.run("refRegistry.begin(1);refRegistry.remember('g1-e1', target)", {
      target,
    });
    expect(f.run("return refRegistry.resolve('g1-e1')")).toBeNull();
  });

  it("fails closed when composed ancestry exceeds the bounded walk", () => {
    const f = fixture();
    const target = f.node("span");
    let parent = target;
    for (let i = 0; i < 257; i++) {
      const next = f.node("div");
      parent.parentElement = next;
      parent = next;
    }
    f.run("refRegistry.begin(1);refRegistry.remember('g1-e1', target)", {
      target,
    });
    expect(f.run("return refRegistry.resolve('g1-e1')")).toBeNull();
  });

  it.each(["article", "li", "tr", "custom-result"])(
    "rejects reused controls in a %s when item links change",
    (tag) => {
      const f = fixture(),
        item = f.node(tag),
        link = f.node("a"),
        button = f.node();
      item.firstElementChild = link;
      item.nextElementSibling = f.node(tag);
      link.nextElementSibling = button;
      link.parentElement = item;
      button.parentElement = item;
      link.setAttribute("href", "/one");
      f.run("refRegistry.begin(1);refRegistry.remember('g1-e1', target)", {
        target: button,
      });
      expect(f.run("return refRegistry.resolve('g1-e1')")).toBe(button);
      expect(f.run("return refRegistry.needsGuard('g1-e1')")).toBe(true);
      link.setAttribute("href", "/two");
      expect(f.run("return refRegistry.resolve('g1-e1')")).toBeNull();
      expect(f.run("return refRegistry.reason('g1-e1')")).toBe(
        "context_changed",
      );
      link.setAttribute("href", "/one");
      expect(f.run("return refRegistry.resolve('g1-e1')")).toBeNull();
    },
  );

  it.each(["data-item-id", "data-id", "data-key", "data-video-id"])(
    "guards explicit %s identities without relying on labels",
    (attribute) => {
      const f = fixture(),
        item = f.node("div"),
        button = f.node();
      item.setAttribute(attribute, "one");
      button.parentElement = item;
      f.run("refRegistry.begin(1);refRegistry.remember('g1-e1', target)", {
        target: button,
      });
      button.setAttribute("aria-label", "Pause");
      expect(f.run("return refRegistry.resolve('g1-e1')")).toBe(button);
      item.setAttribute(attribute, "two");
      expect(f.run("return refRegistry.resolve('g1-e1')")).toBeNull();
    },
  );

  it("rejects movement into a different item even when destinations match", () => {
    const f = fixture(),
      first = f.node("li"),
      second = f.node("li"),
      target = f.node();
    target.parentElement = first;
    f.run("refRegistry.begin(1);refRegistry.remember('g1-e1', target)", {
      target,
    });
    target.parentElement = second;
    expect(f.run("return refRegistry.resolve('g1-e1')")).toBeNull();
  });

  it("does not fingerprint ordinary page text or unrelated links", () => {
    const f = fixture(),
      root = f.node("div"),
      button = f.node(),
      link = f.node("a");
    button.parentElement = root;
    root.firstElementChild = link;
    link.setAttribute("href", "/one");
    f.run("refRegistry.begin(1);refRegistry.remember('g1-e1', target)", {
      target: button,
    });
    link.setAttribute("href", "/two");
    expect(f.run("return refRegistry.resolve('g1-e1')")).toBe(button);
    expect(f.run("return refRegistry.needsGuard('g1-e1')")).toBe(false);
  });

  it("recognizes repeated custom items separated by bounded separator nodes", () => {
    const f = fixture(),
      item = f.node("custom-result"),
      separator = f.node("hr"),
      target = f.node();
    item.nextElementSibling = separator;
    separator.nextElementSibling = f.node("custom-result");
    target.parentElement = item;
    f.run("refRegistry.begin(1);refRegistry.remember('g1-e1', target)", {
      target,
    });
    expect(f.run("return refRegistry.needsGuard('g1-e1')")).toBe(true);
  });

  it("bounds large article scans without making their controls unusable", () => {
    const f = fixture(),
      item = f.node("article"),
      target = f.node();
    target.parentElement = item;
    let previous = item;
    for (let i = 0; i < 260; i++) {
      const next = f.node("span");
      previous.firstElementChild = next;
      previous = next;
    }
    f.run("refRegistry.begin(1);refRegistry.remember('g1-e1', target)", {
      target,
    });
    expect(f.run("return refRegistry.resolve('g1-e1')")).toBe(target);
  });

  it("rejects oversized identity values without prefix collisions", () => {
    const f = fixture(),
      item = f.node("article"),
      target = f.node();
    target.parentElement = item;
    item.setAttribute("data-item-id", "x".repeat(16385));
    f.run("refRegistry.begin(1);refRegistry.remember('g1-e1', target)", {
      target,
    });
    expect(f.run("return refRegistry.resolve('g1-e1')")).toBeNull();
    expect(f.run("return refRegistry.reason('g1-e1')")).toBe("context_limit");
  });

  it("retains explicit item identity when a large link set exceeds the cap", () => {
    const f = fixture(),
      item = f.node("article"),
      target = f.node();
    target.parentElement = item;
    item.setAttribute("data-id", "one");
    let previous = null as ReturnType<typeof f.node> | null;
    for (let i = 0; i < 20; i++) {
      const link = f.node("a");
      link.setAttribute("href", `/item/${i}`);
      if (previous) previous.nextElementSibling = link;
      else item.firstElementChild = link;
      previous = link;
    }
    f.run("refRegistry.begin(1);refRegistry.remember('g1-e1', target)", {
      target,
    });
    expect(f.run("return refRegistry.resolve('g1-e1')")).toBe(target);
    item.setAttribute("data-id", "two");
    expect(f.run("return refRegistry.resolve('g1-e1')")).toBeNull();
  });

  it("bounds serialized context identity, including escaped characters", () => {
    const f = fixture(),
      item = f.node("li"),
      target = f.node();
    target.parentElement = item;
    item.setAttribute("data-id", "\u0000".repeat(3000));
    f.run("refRegistry.begin(1);refRegistry.remember('g1-e1', target)", {
      target,
    });
    expect(f.run("return refRegistry.resolve('g1-e1')")).toBeNull();
    expect(f.run("return refRegistry.reason('g1-e1')")).toBe("context_limit");
  });

  it.each(["assignedSlot", "shadowHost", "parentElement"] as const)(
    "follows button descendants and item identity through %s",
    (parentKey) => {
      const f = fixture(),
        item = f.node("li"),
        button = f.node(),
        target = f.node("span");
      target[parentKey] = button;
      button.parentElement = item;
      item.setAttribute("data-id", "one");
      f.run("refRegistry.begin(1);refRegistry.remember('g1-e1', target)", {
        target,
      });
      item.setAttribute("data-id", "two");
      expect(f.run("return refRegistry.resolve('g1-e1')")).toBeNull();
    },
  );

  it.each(["listitem", "row", "article"])("recognizes the %s role", (role) => {
    const f = fixture(),
      item = f.node("div"),
      target = f.node();
    item.setAttribute("role", role);
    target.parentElement = item;
    f.run("refRegistry.begin(1);refRegistry.remember('g1-e1', target)", {
      target,
    });
    expect(f.run("return refRegistry.needsGuard('g1-e1')")).toBe(true);
  });

  it("keeps reason diagnostics bounded and does not expose URLs or page content", () => {
    const f = fixture(),
      target = f.node("a");
    target.setAttribute("href", "/first?secret=fixture");
    f.run("refRegistry.begin(1);refRegistry.remember('g1-e1', target)", {
      target,
    });
    target.setAttribute("href", "/second?secret=fixture");
    f.run("refRegistry.resolve('g1-e1')");
    expect(f.run("return refRegistry.reason('g1-e1')")).toBe(
      "destination_changed",
    );
    target.isConnected = false;
    expect(f.run("return refRegistry.reason('g1-e1')")).toBe("node_detached");
    f.run("refRegistry.begin(2)");
    expect(f.run("return refRegistry.reason('g1-e1')")).toBe(
      "generation_changed",
    );
  });
});
