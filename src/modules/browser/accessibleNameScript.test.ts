import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL(
    "../../../src-tauri/src/modules/browser_automation/accessibleName.js",
    import.meta.url,
  ),
  "utf8",
);
class Element {
  nodeType = 1;
  childNodes: (Element | { nodeType: number; textContent: string })[] = [];
  labels: Element[] = [];
  type = "text";
  value = "";
  hidden = false;
  attrs: Record<string, string> = {};
  root = { getElementById: (_id: string): Element | null => null };
  constructor(
    public tagName = "BUTTON",
    text = "",
  ) {
    if (text) this.childNodes.push({ nodeType: 3, textContent: text });
  }
  getAttribute(name: string) {
    return this.attrs[name] ?? null;
  }
  getRootNode() {
    return this.root;
  }
}
function name(el: Element) {
  return vm.runInNewContext(`${source}; accessibleName(el)`, {
    el,
    document: el.root,
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
  });
}
describe("shipped accessible-name policy", () => {
  it("prefers button/link contents to tooltip text", () => {
    for (const tag of ["BUTTON", "A"]) {
      const el = new Element(tag, "Save changes");
      el.attrs.title = "Tooltip";
      expect(name(el)).toBe("Save changes");
    }
  });
  it("resolves labelledby in the element's root before aria-label and labels", () => {
    const el = new Element("INPUT");
    const label = new Element("SPAN", "Shadow label");
    label.hidden = true;
    el.root.getElementById = (id) => (id === "label" ? label : null);
    el.attrs = {
      "aria-labelledby": "missing label",
      "aria-label": "ARIA",
      placeholder: "Placeholder",
    };
    el.labels = [new Element("LABEL", "Associated")];
    expect(name(el)).toBe("Shadow label");
    el.attrs["aria-labelledby"] = "missing";
    expect(name(el)).toBe("ARIA");
    delete el.attrs["aria-label"];
    expect(name(el)).toBe("Associated");
    el.labels = [];
    el.attrs.title = "Title";
    expect(name(el)).toBe("Title");
    delete el.attrs.title;
    expect(name(el)).toBe("Placeholder");
  });
  it("includes icon alternatives and excludes hidden or script descendants", () => {
    const el = new Element();
    const image = new Element("IMG");
    image.attrs.alt = "Search";
    const hidden = new Element("SPAN", "secret");
    hidden.attrs["aria-hidden"] = "true";
    el.childNodes = [hidden, new Element("SCRIPT", "script"), image];
    expect(name(el)).toBe("Search");
  });
  it("never exposes editable values as names", () => {
    for (const type of ["password", "text", "email", "file"]) {
      const el = new Element("INPUT");
      el.type = type;
      el.value = "private-value";
      expect(name(el)).toBe("");
    }
    const submit = new Element("INPUT");
    submit.type = "submit";
    submit.value = "Send";
    expect(name(submit)).toBe("Send");
  });
  it("bounds both traversal and output", () => {
    const el = new Element();
    el.childNodes = Array.from(
      { length: 500 },
      (_, i) => new Element("SPAN", `node${i}`),
    );
    expect(name(el)).not.toContain("node499");
    el.childNodes = [new Element("SPAN", "x".repeat(10000))];
    expect(name(el)).toHaveLength(4096);
  });
});
