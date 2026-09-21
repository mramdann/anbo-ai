import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL(
    "../../../src-tauri/src/modules/browser_automation/valueAction.js",
    import.meta.url,
  ),
  "utf8",
);

function harness(select = false) {
  const events: string[] = [];
  class Input {
    tagName = "INPUT";
    disabled = false;
    readOnly = false;
    isConnected = true;
    isContentEditable = false;
    textContent = "";
    visible = true;
    inheritedDisabled = false;
    stored = "";
    options = [
      {
        value: "a",
        textContent: "Alpha",
        disabled: false,
        selected: true,
        matches: () => false,
      },
      {
        value: "b",
        textContent: "Beta",
        disabled: false,
        selected: false,
        matches: () => false,
      },
    ];
    get value() {
      return this.stored;
    }
    set value(value: string) {
      this.stored = value;
      if (this.tagName === "SELECT")
        for (const option of this.options)
          option.selected = option.value === value;
    }
    attributes: Record<string, string> = {};
    type = "text";
    getAttribute(name: string) {
      return this.attributes[name] ?? null;
    }
    matches(_selector: string) {
      return this.inheritedDisabled;
    }
    focus = () => {};
    handler = (_type: string) => {};
    dispatchEvent(event: { type: string }) {
      events.push(event.type);
      this.handler(event.type);
    }
  }
  class Textarea extends Input {}
  class InputEvent {
    constructor(public type: string) {}
  }
  const el = new Input();
  if (select) {
    el.tagName = "SELECT";
    el.value = "a";
  }
  let live: Input | null = el;
  const context = vm.createContext({
    el,
    refRegistry: { resolve: () => live },
    HTMLInputElement: Input,
    HTMLTextAreaElement: Textarea,
    InputEvent,
    Event: InputEvent,
    isRenderedElement: (node: Input) => node.visible,
    // The page the value action runs in: fillValue records where the caller
    // acted so the reply can say what the action changed.
    location: { href: "https://example.test/search" },
    document: { title: "Example" },
  });
  vm.runInContext(source, context);
  return {
    el,
    events,
    detach: () => {
      live = null;
    },
    run: (text = "b", append = false, verify = true) =>
      vm.runInContext(
        select
          ? `selectValue(el, refRegistry, 'g1-e1', ${JSON.stringify(text)})`
          : `fillValue(el, refRegistry, 'g1-e1', ${JSON.stringify(text)}, ${append}, ${verify})`,
        context,
      ),
  };
}

describe("guarded value actions", () => {
  it("fills and appends with exactly one input/change pair each", () => {
    const h = harness();
    expect(h.run("hello").ok).toBe(true);
    expect(h.run(" world", true).ok).toBe(true);
    expect(h.el.value).toBe("hello world");
    expect(h.events).toEqual(["input", "change", "input", "change"]);
  });

  it.each(["disabled", "inheritedDisabled", "readOnly"] as const)(
    "rejects %s without writing or events",
    (field) => {
      const h = harness();
      h.el[field] = true;
      expect(h.run()).toMatchObject({ ok: false, error: "input_not_ready" });
      expect(h.el.value).toBe("");
      expect(h.events).toEqual([]);
    },
  );

  it("rechecks readiness and identity after focus handlers", () => {
    const h = harness();
    h.el.focus = () => {
      h.el.readOnly = true;
    };
    expect(h.run().error).toBe("input_not_ready");
    expect(h.events).toEqual([]);
    const replaced = harness();
    replaced.el.focus = replaced.detach;
    expect(replaced.run().error).toBe("stale_ref");
    expect(replaced.events).toEqual([]);
  });

  it.each([false, true])(
    "detects a value reverted by handlers without repeating: select=%s",
    (select) => {
      const h = harness(select);
      h.el.handler = () => {
        h.el.value = "a";
      };
      expect(h.run()).toMatchObject({ ok: false, error: "input_mismatch" });
      expect(h.events).toEqual(["input", "change"]);
    },
  );

  it("marks a verified mismatch as dispatched with the retained flag", () => {
    const h = harness();
    h.el.handler = () => {
      h.el.value = "a";
    };
    expect(h.run("b")).toMatchObject({
      ok: false,
      error: "input_mismatch",
      dispatched: true,
      valueRetained: false,
    });
    expect(h.events).toEqual(["input", "change"]);
  });

  it("accepts a value the field clears after dispatch when verifyValue is false", () => {
    const h = harness();
    h.el.handler = () => {
      h.el.value = "";
    };
    expect(h.run("hello", false, false)).toMatchObject({
      ok: true,
      dispatched: true,
      valueRetained: false,
    });
    expect(h.el.value).toBe("");
    expect(h.events).toEqual(["input", "change"]);
  });

  it("still fails a ref detached during dispatch even when verifyValue is false", () => {
    const h = harness();
    h.el.handler = h.detach;
    expect(h.run("b", false, false)).toMatchObject({
      ok: false,
      error: "stale_ref",
      dispatched: true,
    });
    expect(h.events).toEqual(["input", "change"]);
  });

  it("selects by label and verifies the selected option", () => {
    const h = harness(true);
    expect(h.run("Beta")).toMatchObject({
      ok: true,
      value: "b",
      valueVerified: true,
    });
    expect(h.el.value).toBe("b");
    expect(h.events).toEqual(["input", "change"]);
  });

  it("rejects disabled options and disabled optgroups", () => {
    for (const inherited of [false, true]) {
      const h = harness(true);
      h.el.options[1].disabled = !inherited;
      h.el.options[1].matches = () => inherited;
      expect(h.run()).toMatchObject({ ok: false, error: "input_not_ready" });
      expect(h.el.value).toBe("a");
      expect(h.events).toEqual([]);
    }
  });

  it("rejects an option removed by focus without selecting another", () => {
    const h = harness(true);
    h.el.focus = () => {
      h.el.options.pop();
    };
    expect(h.run().error).toBe("input_not_ready");
    expect(h.events).toEqual([]);
  });

  it("rejects an option repurposed during focus", () => {
    const h = harness(true);
    h.el.focus = () => {
      h.el.options[1].value = "changed";
      h.el.options[1].textContent = "Changed";
    };
    expect(h.run().error).toBe("input_not_ready");
    expect(h.el.value).toBe("a");
    expect(h.events).toEqual([]);
  });

  it("does not claim success after item identity changes in a handler", () => {
    const h = harness();
    h.el.handler = h.detach;
    expect(h.run().ok).toBe(false);
    expect(h.events).toEqual(["input", "change"]);
  });

  it("marks only the fields the page opens something under", () => {
    // An ordinary text box must not buy every caller a wait it cannot use.
    const plain = harness();
    expect(plain.run("hello").popup).toBe(false);

    const declared = harness();
    declared.el.attributes["aria-controls"] = "suggestions";
    expect(declared.run("Zur").popup).toBe(true);

    const combobox = harness();
    combobox.el.attributes.role = "combobox";
    expect(combobox.run("Zur").popup).toBe(true);

    // Wikipedia's box declares nothing and still opens a list, so the search
    // roles have to count as well.
    const search = harness();
    search.el.type = "search";
    expect(search.run("Zur").popup).toBe(true);

    const list = harness();
    list.el.attributes.list = "cities";
    expect(list.run("Zur").popup).toBe(true);
  });

  it("records where the caller acted before the value changed", () => {
    const filled = harness().run("hello");
    expect(filled.before).toEqual({
      url: "https://example.test/search",
      title: "Example",
    });
  });
});
