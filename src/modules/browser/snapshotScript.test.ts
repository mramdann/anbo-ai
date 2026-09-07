import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

function template(source: string, pattern: RegExp): string {
  const match = source.match(pattern)?.[1];
  if (!match) throw new Error("Browser script template missing");
  return match;
}

const snapshotSource = readFileSync(
  new URL(
    "../../../src-tauri/src/modules/browser_automation/snapshot.rs",
    import.meta.url,
  ),
  "utf8",
);
const snapshotTemplate = template(
  snapshotSource,
  /r#"(\(function\(\) \{\{[\s\S]*?)"#,/,
);
const visibilityScript = template(
  readFileSync(
    new URL(
      "../../../src-tauri/src/modules/browser_automation/visibility.rs",
      import.meta.url,
    ),
    "utf8",
  ),
  /r#"([\s\S]*?)"#/,
);
const accessibleNameScript = readFileSync(
  new URL(
    "../../../src-tauri/src/modules/browser_automation/accessibleName.js",
    import.meta.url,
  ),
  "utf8",
);

class Element {
  nodeType = 1;
  isConnected = true;
  parentElement: Element | null = null;
  opacity = "1";
  attributes = new Map<string, string>();
  childNodes: Element[] = [];
  shadowRoot: Element | null = null;
  disabled = false;
  value: string | undefined;
  constructor(
    public tagName: string,
    public innerText = "",
    public inViewport = false,
    public hidden = false,
  ) {
    if (innerText) {
      const text = new Element("#text");
      text.nodeType = 3;
      Object.assign(text, { textContent: innerText });
      this.childNodes.push(text);
    }
  }
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
  hasAttribute(name: string) {
    return this.attributes.has(name);
  }
  querySelector() {
    return null;
  }
  getBoundingClientRect() {
    return {
      width: this.hidden ? 0 : 100,
      height: this.hidden ? 0 : 24,
      top: this.inViewport ? 20 : -1000,
      bottom: this.inViewport ? 44 : -976,
      left: 10,
      right: 110,
    };
  }
  querySelectorAll(selector: string): Element[] {
    const nodes = this.childNodes.flatMap((child) => [
      child,
      ...child.querySelectorAll("*"),
    ]);
    return selector === "*"
      ? nodes
      : nodes.filter((node) => node.hasAttribute("data-anbo-ref"));
  }
}

function fixture(nodes: Element[]) {
  const body = new Element("BODY");
  body.childNodes = nodes;
  const attach = (parent: Element) => {
    for (const child of parent.childNodes) {
      child.parentElement = parent;
      attach(child);
    }
  };
  attach(body);
  const documentElement = new Element("HTML");
  const document = {
    body,
    documentElement,
    title: "Snapshot fixture",
    getElementById: () => null,
    querySelectorAll: (selector: string) => body.querySelectorAll(selector),
  };
  const context = vm.createContext({
    document,
    getComputedStyle: (element: Element) => ({
      display: element.hidden ? "none" : "block",
      visibility: "visible",
      opacity: element.opacity,
    }),
    window: {
      innerWidth: 800,
      innerHeight: 600,
      location: { href: "http://fixture.invalid/" },
      getComputedStyle: (element: Element) => ({
        display: element.hidden ? "none" : "block",
        visibility: "visible",
        opacity: "1",
      }),
    },
  });
  return (generation: number) => {
    const script = snapshotTemplate
      .split("{generation_id}")
      .join(String(generation))
      .split("{ref_prefix_json}")
      .join(JSON.stringify(`g${generation}-e`))
      .split("{{")
      .join("{")
      .split("}}")
      .join("}")
      .split("{VISIBILITY_JS}")
      .join(visibilityScript)
      .split("{ACCESSIBLE_NAME_JS}")
      .join(accessibleNameScript);
    return JSON.parse(vm.runInContext(script, context)) as {
      elements: {
        label: string;
        ref_id: string;
        value: string | null;
        in_viewport: boolean;
      }[];
      source_truncated: boolean;
    };
  };
}

describe("shipped browser snapshot script", () => {
  it("omits controls under transparent ancestors", () => {
    const container = new Element("DIV", "", true);
    container.opacity = "0";
    container.childNodes = [new Element("BUTTON", "hidden-control", true)];
    expect(fixture([container])(1).elements).toHaveLength(0);
  });
  it("collects a visible target after more than 1000 offscreen controls", () => {
    const nodes = Array.from(
      { length: 1200 },
      (_, index) => new Element("BUTTON", `earlier-${index}`),
    );
    nodes.push(new Element("BUTTON", "visible-target", true));
    const payload = fixture(nodes)(1);
    expect(payload.elements).toHaveLength(1000);
    expect(payload.elements[0].label).toBe("visible-target");
    expect(payload.source_truncated).toBe(true);
  });

  it("distinguishes an exact item limit from omitted siblings", () => {
    const nodes = Array.from(
      { length: 1000 },
      () => new Element("BUTTON", "item"),
    );
    expect(fixture(nodes)(1).source_truncated).toBe(false);
    nodes.push(new Element("BUTTON", "omitted"));
    expect(fixture(nodes)(2).source_truncated).toBe(true);
  });

  it("keeps hidden file inputs and redacts passwords", () => {
    const upload = new Element("INPUT", "", false, true);
    upload.setAttribute("type", "file");
    const password = new Element("INPUT", "", true);
    password.setAttribute("type", "password");
    password.value = "fixture-secret";
    const payload = fixture([upload, password])(1);
    expect(payload.elements).toHaveLength(2);
    expect(payload.elements[0].value).toBe("[REDACTED]");
    expect(JSON.stringify(payload)).not.toContain("fixture-secret");
  });

  it("retains visible controls inside open shadow roots", () => {
    const host = new Element("DIV");
    host.shadowRoot = new Element("SHADOW");
    host.shadowRoot.childNodes = [new Element("BUTTON", "shadow-target", true)];
    expect(fixture([host])(1).elements[0].label).toBe("shadow-target");
  });

  it("rejects a late older scan before it can erase newer refs", () => {
    const target = new Element("BUTTON", "target", true);
    const run = fixture([target]);
    const fresh = run(2);
    expect(() => run(1)).toThrow("stale_scan");
    expect(target.getAttribute("data-anbo-ref")).toBe(fresh.elements[0].ref_id);
  });
});

const actionsSource = readFileSync(
  new URL(
    "../../../src-tauri/src/modules/browser_automation/actions.rs",
    import.meta.url,
  ),
  "utf8",
);
const observerFunction = actionsSource.slice(
  actionsSource.indexOf("fn submission_observer_script"),
  actionsSource.indexOf("async fn cleanup_submission_observer"),
);
const observerTemplate = template(observerFunction, /r#"([\s\S]*?)"#/);

describe("shipped submission observer script", () => {
  it("removes listeners and timers after both explicit and fallback cleanup", () => {
    for (const fallback of [false, true]) {
      const listeners = new Set<() => void>();
      const timers = new Map<number, () => void>();
      const context = vm.createContext({
        window: {},
        document: {
          addEventListener: (_name: string, listener: () => void) =>
            listeners.add(listener),
          removeEventListener: (_name: string, listener: () => void) =>
            listeners.delete(listener),
        },
        setTimeout: (callback: () => void) => {
          timers.set(1, callback);
          return 1;
        },
        clearTimeout: (id: number) => timers.delete(id),
      });
      const script = observerTemplate
        .split("{observation_id}")
        .join("42")
        .split("{lifetime_ms}")
        .join("13000")
        .split("{{")
        .join("{")
        .split("}}")
        .join("}");
      vm.runInContext(script, context);
      expect(listeners.size).toBe(1);
      for (const listener of listeners) listener();
      expect(
        vm.runInContext(
          "window.__anboSubmitObservations['42'].submitted",
          context,
        ),
      ).toBe(true);
      if (fallback) timers.get(1)?.();
      else
        vm.runInContext(
          "window.__anboSubmitObservations['42'].cleanup()",
          context,
        );
      expect(listeners.size).toBe(0);
      expect(timers.size).toBe(0);
      expect(
        vm.runInContext(
          "Object.keys(window.__anboSubmitObservations).length",
          context,
        ),
      ).toBe(0);
    }
  });
});
