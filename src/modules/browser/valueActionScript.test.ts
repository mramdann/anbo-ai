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
const baselineSource = readFileSync(
  new URL(
    "../../../src-tauri/src/modules/browser_automation/revealBaseline.js",
    import.meta.url,
  ),
  "utf8",
);

function harness(select = false) {
  const events: string[] = [];
  let surfaceScans = 0;
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
    document: {
      title: "Example",
      querySelectorAll: () => {
        surfaceScans++;
        return [];
      },
    },
  });
  vm.runInContext(`${baselineSource}\n${source}`, context);
  return {
    el,
    events,
    scans: () => surfaceScans,
    detach: () => {
      live = null;
    },
    run: (text = "b", append = false, verify = true, capture = false) =>
      vm.runInContext(
        select
          ? `selectValue(el, refRegistry, 'g1-e1', ${JSON.stringify(text)})`
          : `fillValue(el, refRegistry, 'g1-e1', ${JSON.stringify(text)}, ${append}, ${verify}, ${capture})`,
        context,
      ),
  };
}

describe("guarded value actions", () => {
  it("captures before focus/input and skips work for ordinary or disabled reveal", () => {
    const h = harness();
    h.run("plain", false, true, true);
    expect(h.scans()).toBe(0);
    h.el.attributes.role = "combobox";
    h.run("disabled", false, true, false);
    expect(h.scans()).toBe(0);
    h.el.focus = () => {
      expect(h.scans()).toBe(1);
    };
    h.el.handler = () => {
      expect(h.scans()).toBe(1);
    };
    const result = h.run("capture", false, true, true);
    expect(result.ok).toBe(true);
    expect(result.before.revealToken).toBeGreaterThan(0);
  });

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

  it("names the options when no value or whole label matches", () => {
    // Round 64 (R64-8): a part of a label failed with a bare option_not_found.
    const h = harness(true);
    const result = h.run("Bet");
    expect(result).toMatchObject({ ok: false, error: "option_not_found" });
    expect(result.options.length).toBeGreaterThan(0);
    expect(result.options).toContainEqual({ value: "b", label: "Beta" });
    expect(result.optionCount).toBe(h.el.options.length);
    expect(h.events).toEqual([]);
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

// A select whose own option list a click left open. Chromium on Windows closes
// that list the same way whatever closes it: it applies the option the arrow
// keys highlighted and tells the page, unless a listener earlier on the event
// path stops the news.
function openList({
  closes = true,
  customizable = false,
  knowsOpen = true,
} = {}) {
  type Heard = {
    type: string;
    composedPath: () => unknown[];
    stopImmediatePropagation: () => void;
  };
  const capture = new Map<string, Array<(event: Heard) => void>>();
  const heard: string[] = [];
  const view = {
    addEventListener(
      type: string,
      listener: (event: Heard) => void,
      useCapture: boolean,
    ) {
      expect(useCapture).toBe(true);
      capture.set(type, [...(capture.get(type) ?? []), listener]);
    },
    removeEventListener(type: string, listener: (event: Heard) => void) {
      capture.set(
        type,
        (capture.get(type) ?? []).filter((held) => held !== listener),
      );
    },
    getComputedStyle: (_el: unknown, pseudo: string) => ({
      appearance:
        customizable && pseudo === "::picker(select)" ? "base-select" : "none",
    }),
  };
  const document = { defaultView: view };
  const options = [
    ["", "Pilih"],
    ["reguler", "Reguler"],
    ["ekspres", "Ekspres"],
  ].map(([value, textContent], index) => ({
    value,
    textContent,
    disabled: false,
    selected: index === 0,
    matches: () => false,
  }));
  const state = { open: true, focused: true };
  const el = {
    tagName: "SELECT",
    disabled: false,
    isConnected: true,
    options,
    ownerDocument: document,
    getRootNode: () => document,
    get selectedIndex() {
      return options.findIndex((option) => option.selected);
    },
    set selectedIndex(index: number) {
      options.forEach((option, at) => {
        option.selected = at === index;
      });
    },
    get value() {
      return options.find((option) => option.selected)?.value ?? "";
    },
    set value(value: string) {
      for (const option of options) option.selected = option.value === value;
    },
    getAttribute: () => null,
    matches(selector: string) {
      if (selector !== ":open") return false;
      if (!knowsOpen) throw new SyntaxError("unknown pseudo-class");
      return state.open;
    },
    dispatchEvent(event: { type: string }) {
      fire(event.type);
      return true;
    },
    blur() {
      if (!state.focused) return;
      if (state.open && closes) {
        state.open = false;
        el.value = "ekspres";
        fire("input");
        fire("change");
      }
      state.focused = false;
      fire("blur");
      fire("focusout");
    },
    focus() {
      if (state.focused) return;
      state.focused = true;
      fire("focus");
      fire("focusin");
    },
  };
  function fire(type: string) {
    let stopped = false;
    const event = {
      type,
      composedPath: () => [el],
      stopImmediatePropagation: () => {
        stopped = true;
      },
    };
    for (const listener of capture.get(type) ?? []) {
      listener(event);
      if (stopped) return;
    }
    heard.push(`${type}:${el.value}`);
  }
  class Event {
    constructor(public type: string) {}
  }
  const context = vm.createContext({
    el,
    refRegistry: { resolve: () => el },
    HTMLInputElement: class {},
    HTMLTextAreaElement: class {},
    Event,
    InputEvent: Event,
    isRenderedElement: () => true,
  });
  vm.runInContext(`${baselineSource}\n${source}`, context);
  return {
    el,
    state,
    heard,
    listening: () =>
      Array.from(capture.values()).reduce((sum, held) => sum + held.length, 0),
    run: (want: string) =>
      vm.runInContext(
        `selectValue(el, refRegistry, 'g1-e1', ${JSON.stringify(want)})`,
        context,
      ),
  };
}

describe("a select whose own option list is open", () => {
  it("closes the list out of the page's sight before choosing", () => {
    // An agent clicked the select, pressed ArrowDown twice, then chose
    // Reguler: the list applied Ekspres at the next click, after the choice
    // had been reported as held, and the order went out with Ekspres.
    const h = openList();
    expect(h.run("Reguler")).toMatchObject({
      ok: true,
      value: "reguler",
      valueVerified: true,
      closedPicker: true,
    });
    expect(h.state).toEqual({ open: false, focused: true });
    expect(h.heard).toEqual(["input:reguler", "change:reguler"]);
    expect(h.listening()).toBe(0);
  });

  it("writes nothing when the list does not close", () => {
    const h = openList({ closes: false });
    expect(h.run("Reguler")).toEqual({ ok: false, error: "picker_open" });
    expect(h.el.value).toBe("");
    expect(h.state.focused).toBe(true);
    expect(h.heard).toEqual([]);
    expect(h.listening()).toBe(0);
  });

  it("leaves a customizable select's list alone, which applies nothing on close", () => {
    const h = openList({ customizable: true });
    expect(h.run("Reguler")).toMatchObject({ ok: true, closedPicker: false });
    expect(h.state.open).toBe(true);
    expect(h.heard).toEqual(["input:reguler", "change:reguler"]);
  });

  it("chooses as before where there is no open list or no way to tell", () => {
    const closed = openList();
    closed.state.open = false;
    expect(closed.run("Reguler")).toMatchObject({
      ok: true,
      closedPicker: false,
    });
    expect(closed.heard).toEqual(["input:reguler", "change:reguler"]);
    const older = openList({ knowsOpen: false });
    expect(older.run("Reguler")).toMatchObject({
      ok: true,
      closedPicker: false,
    });
    expect(older.heard).toEqual(["input:reguler", "change:reguler"]);
  });
});
