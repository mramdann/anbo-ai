import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL(
    "../../../src-tauri/src/modules/browser_automation/dragProbe.js",
    import.meta.url,
  ),
  "utf8",
);

function fixture() {
  let scrollY = 0;
  const scrolls: string[] = [];
  const elements: Element[] = [];
  const root = {
    elementFromPoint: (x: number, y: number): Element | null =>
      elements.find((el) => {
        const rect = el.getBoundingClientRect();
        return (
          x >= rect.left &&
          x < rect.left + rect.width &&
          y >= rect.top &&
          y < rect.top + rect.height
        );
      }) ?? null,
  };
  class Element {
    disabled = false;
    hidden = false;
    generation = "gen-1";
    constructor(
      public top: number,
      public height: number,
    ) {
      elements.push(this);
    }
    getAttribute(name: string) {
      return name === "data-anbo-gen" ? this.generation : null;
    }
    getRootNode() {
      return root;
    }
    getBoundingClientRect() {
      return {
        left: 20,
        top: this.top - scrollY,
        width: 80,
        height: this.height,
      };
    }
    scrollIntoView(options: { block: string }) {
      scrolls.push(options.block);
      if (options.block === "center")
        scrollY = this.top + this.height / 2 - 300;
      else if (this.top - scrollY + this.height > 600)
        scrollY = this.top + this.height - 600;
      else if (this.top - scrollY < 0) scrollY = this.top;
    }
  }
  const from = new Element(1200, 40),
    to = new Element(1600, 60);
  const run = (scroll = true) =>
    JSON.parse(
      vm.runInNewContext(`(() => {${source}})()`, {
        source: from,
        destination: to,
        generation: "gen-1",
        scroll,
        innerWidth: 800,
        innerHeight: 600,
        document: root,
        isRenderedElement: (el: Element) => !el.hidden,
      }),
    );
  return { from, to, run, scrolls, root };
}

describe("shipped drag endpoint probe", () => {
  it("measures both endpoints after all scrolling, not a cached source point", () => {
    const f = fixture();
    const result = f.run();
    expect(f.scrolls).toEqual(["center", "nearest"]);
    expect(result.points).toEqual([60, 160, 60, 570]);
    expect(f.run(false)).toEqual(result);
    expect(f.scrolls).toHaveLength(2);
  });
  it("rejects stale refs before any scrolling", () => {
    const f = fixture();
    f.from.generation = "gen-0";
    expect(f.run().error).toBe("stale_ref");
    expect(f.scrolls).toHaveLength(0);
  });
  it("rejects endpoints that cannot share a viewport instead of pressing elsewhere", () => {
    const f = fixture();
    f.to.top = 2600;
    expect(f.run().error).toContain(
      "both drag endpoints must be visible together",
    );
  });
  it("revalidates hidden, disabled and covered endpoints", () => {
    const f = fixture();
    f.from.disabled = true;
    expect(f.run().error).toContain("source is disabled");
    f.from.disabled = false;
    f.to.hidden = true;
    expect(f.run().error).toContain("target is not visible");
    f.to.hidden = false;
    f.root.elementFromPoint = () => null;
    expect(f.run().error).toContain("covered by another element");
  });
});
