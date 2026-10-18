import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const SCRIPT = readFileSync(new URL("./app_links.js", import.meta.url), "utf8");

class FakeNode {
  constructor(nodeName, props = {}) {
    this.nodeName = nodeName;
    Object.assign(this, props);
  }
}

function webview(label) {
  const listeners = [];
  const invoke = vi.fn();
  const window = {
    __TAURI_INTERNALS__: label === undefined ? { invoke } : { invoke, metadata: { currentWebview: { label } } },
    addEventListener: vi.fn((type, listener) => listeners.push([type, listener])),
  };
  new Function("window", "Node", SCRIPT)(window, FakeNode);
  const click = (link, keys = {}) => {
    const event = { button: 0, defaultPrevented: false, ctrlKey: false, shiftKey: false, metaKey: false, altKey: false, ...keys, composedPath: () => [new FakeNode("SPAN"), link, new FakeNode("BODY")], preventDefault: vi.fn() };
    for (const [type, listener] of listeners) if (type === "click") listener(event);
    return event;
  };
  return { window, invoke, click };
}

const blank = new FakeNode("A", { href: "https://example.com/next", target: "_blank" });
const plain = new FakeNode("A", { href: "https://example.com/plain", target: "" });

describe("links in Anbo's own windows", () => {
  it("still open a new-window link in the system's browser", () => {
    const main = webview("main");
    const event = main.click(blank);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(main.invoke).toHaveBeenCalledWith("plugin:opener|open_url", { url: "https://example.com/next" });
    for (const keys of [{ ctrlKey: true }, { shiftKey: true }]) main.click(plain, keys);
    expect(main.invoke).toHaveBeenCalledTimes(3);
  });

  it("leave a plain click, a middle click, a handled click and other schemes alone", () => {
    const main = webview("settings");
    main.click(plain);
    main.click(blank, { button: 1 });
    main.click(blank, { altKey: true });
    main.click(blank, { defaultPrevented: true });
    main.click(new FakeNode("A", { href: "javascript:void 0", target: "_blank" }));
    expect(main.invoke).not.toHaveBeenCalled();
  });

  it("never touch the links of a page in Anbo's browser", () => {
    for (const label of ["browser-embed-4", undefined]) {
      const tab = webview(label);
      expect(tab.window.addEventListener).not.toHaveBeenCalled();
      const event = tab.click(blank);
      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(tab.invoke).not.toHaveBeenCalled();
    }
  });
});
