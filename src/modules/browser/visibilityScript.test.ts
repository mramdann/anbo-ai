import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

const source = readFileSync(
  new URL(
    "../../../src-tauri/src/modules/browser_automation/visibility.rs",
    import.meta.url,
  ),
  "utf8",
);
const script = source.match(/r#"([\s\S]*?)"#/)?.[1];
if (!script) throw new Error("Visibility helper missing");

class Element {
  isConnected = true;
  parentElement: Element | null = null;
  assignedSlot: Element | null = null;
  host: Element | null = null;
  styles = {
    display: "block",
    visibility: "visible",
    opacity: "1",
    contentVisibility: "visible",
  };
  rect = { width: 100, height: 20, left: -1000, top: -1000 };
  getBoundingClientRect() {
    return this.rect;
  }
  getRootNode() {
    return { host: this.host };
  }
}
const visible = (el: Element) =>
  vm.runInNewContext(`${script}; isRenderedElement(el)`, {
    el,
    getComputedStyle: (node: Element) => node.styles,
  });

describe("shipped rendered visibility policy", () => {
  it("excludes transparent ancestors but retains offscreen rendered elements", () => {
    const el = new Element(),
      parent = new Element();
    el.parentElement = parent;
    expect(visible(el)).toBe(true);
    parent.styles.opacity = "0";
    expect(visible(el)).toBe(false);
    parent.styles.opacity = "0.5";
    expect(visible(el)).toBe(true);
  });
  it("crosses shadow hosts and assigned slots", () => {
    for (const key of ["host", "assignedSlot"] as const) {
      const el = new Element(),
        parent = new Element();
      el[key] = parent;
      parent.styles.opacity = "0";
      expect(visible(el)).toBe(false);
    }
  });
  it("allows a child visibility override but never an opacity override", () => {
    const el = new Element(),
      parent = new Element();
    el.parentElement = parent;
    parent.styles.visibility = "hidden";
    expect(visible(el)).toBe(true);
    el.styles.visibility = "hidden";
    expect(visible(el)).toBe(false);
    el.styles.visibility = "visible";
    parent.styles.opacity = "0";
    expect(visible(el)).toBe(false);
  });
  it("handles content visibility, display contents and no-box elements", () => {
    const el = new Element(),
      parent = new Element();
    el.parentElement = parent;
    parent.styles.display = "contents";
    expect(visible(el)).toBe(true);
    parent.styles.contentVisibility = "hidden";
    expect(visible(el)).toBe(false);
    parent.styles.contentVisibility = "visible";
    el.rect.width = 0;
    expect(visible(el)).toBe(false);
  });
  it("fails closed on disconnected elements and bounded ancestor cycles", () => {
    const el = new Element();
    el.isConnected = false;
    expect(visible(el)).toBe(false);
    el.isConnected = true;
    el.parentElement = el;
    expect(visible(el)).toBe(false);
  });
  it("uses native flat-tree checks with opacity and visibility enabled", () => {
    const el = Object.assign(new Element(), {
      checkVisibility: vi.fn(() => false),
    });
    expect(visible(el)).toBe(false);
    expect(el.checkVisibility).toHaveBeenCalledWith({
      checkOpacity: true,
      checkVisibilityCSS: true,
    });
    el.checkVisibility.mockReturnValue(true);
    expect(visible(el)).toBe(true);
  });
});
