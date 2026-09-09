import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const pageSource = readFileSync(
  new URL(
    "../../../src-tauri/src/modules/browser_automation/page_state.rs",
    import.meta.url,
  ),
  "utf8",
);
const textSource = readFileSync(
  new URL(
    "../../../src-tauri/src/modules/browser_automation/readable_text.rs",
    import.meta.url,
  ),
  "utf8",
);
const textScript = textSource.match(/r#"([\s\S]*?)"#/)?.[1];
if (!textScript) throw new Error("Readable text script missing");

function script(marker: string, values: Record<string, string>) {
  const template = pageSource
    .slice(pageSource.indexOf(marker))
    .match(/r#"([\s\S]*?)"#/)?.[1];
  if (!template) throw new Error(`Missing ${marker}`);
  let result = template;
  for (const [key, value] of Object.entries(values))
    result = result.split(`{${key}}`).join(value);
  // Insert the literal helper after expanding the Rust format template's braces.
  return result
    .split("{{")
    .join("{")
    .split("}}")
    .join("}")
    .split("{READABLE_TEXT_JS}")
    .join(textScript ?? "");
}

const text = (value: string) => ({ nodeType: 3, textContent: value });
interface ElementNode {
  nodeType: number;
  tagName: string;
  childNodes: Node[];
  getAttribute: () => null;
  styles: Record<string, string>;
  parentElement?: ElementNode;
  assignedSlot?: ElementNode;
  assignedNodes?: () => Node[];
  shadowRoot?: { nodeType: number; childNodes: Node[] };
}
type Node = ReturnType<typeof text> | ElementNode;
function element(
  tagName: string,
  childNodes: Node[] = [],
  styles: Record<string, string> = {},
): ElementNode {
  return { nodeType: 1, tagName, childNodes, getAttribute: () => null, styles };
}
const styles = (node: { styles?: Record<string, string> }) => ({
  display: "block",
  visibility: "visible",
  opacity: "1",
  ...node.styles,
});
const read = (root: Node) =>
  vm.runInNewContext(`${textScript}; readableText(root)`, {
    root,
    getComputedStyle: styles,
  });

function slottedFixture() {
  const assigned = element("SPAN", [text("assigned result")]);
  const unassigned = element("SPAN", [text("unassigned secret")]);
  const fallback = element("SPAN", [text("fallback secret")]);
  const slot = element("SLOT", [fallback]);
  slot.assignedNodes = () => [assigned];
  fallback.parentElement = slot;
  assigned.assignedSlot = slot;
  const host = element("DIV", [assigned, unassigned]);
  assigned.parentElement = host;
  unassigned.parentElement = host;
  host.shadowRoot = {
    nodeType: 11,
    childNodes: [text("before slot"), slot, text("after slot")],
  };
  return { host, slot, assigned, unassigned, fallback };
}

describe("shipped readable text script", () => {
  it("reads composed slot order without fallback, unslotted text or duplicates", () => {
    const f = slottedFixture();
    expect(read(f.host).text).toBe("before slot\nassigned result\nafter slot");
    expect(read(f.assigned).text).toBe("assigned result");
    expect(read(f.unassigned).text).toBe("");
    expect(read(f.fallback).text).toBe("");
  });
  it("re-evaluates assignment and only reads fallback when the slot is empty", () => {
    const f = slottedFixture();
    f.slot.assignedNodes = () => [];
    expect(read(f.host).text).toBe("before slot\nfallback secret\nafter slot");
    f.slot.assignedNodes = () => [text("assigned text node")];
    expect(read(f.host).text).toBe(
      "before slot\nassigned text node\nafter slot",
    );
  });
  it("follows nested slots without exposing their fallback", () => {
    const f = slottedFixture();
    const nested = element("SLOT", [text("nested secret")]);
    nested.assignedNodes = () => [element("SPAN", [text("nested result")])];
    f.slot.assignedNodes = () => [nested];
    expect(read(f.host).text).toBe("before slot\nnested result\nafter slot");
    f.slot.styles.opacity = "0";
    expect(read(f.host).text).toBe("before slot\nafter slot");
  });
  it("excludes hidden composed ancestors of shadow and slotted refs", () => {
    const parent = element("DIV", [], { opacity: "0" });
    const root = element("SPAN", [text("hidden-control")]);
    expect(
      read({ ...root, getRootNode: () => ({ host: parent }) } as Node).text,
    ).toBe("");
    expect(read({ ...root, assignedSlot: parent } as Node).text).toBe("");
    expect(
      read(element("DIV", [text("skipped")], { contentVisibility: "hidden" }))
        .text,
    ).toBe("");
  });
  it("does not split a surrogate pair at collection or response boundaries", () => {
    const value = "x".repeat(16000) + String.fromCodePoint(0x1f600);
    const result = read(element("BODY", [text(value)]));
    expect(result.text).toBe("x".repeat(16000));
    expect(result.sourceTruncated).toBe(true);
    expect(
      vm.runInNewContext(`${textScript}; clipReadableText(value, 16001)`, {
        value,
      }),
    ).toBe("x".repeat(16000));
  });
  it("never reads script/style/template or hidden subtrees even when innerText contains them", () => {
    const root = element("BODY", [
      text("Visible result"),
      element("script", [text("script secret")]),
      element("STYLE", [text("style secret")]),
      element("TEMPLATE", [text("template secret")]),
      element("DIV", [text("hidden secret")], { display: "none" }),
    ]);
    const result = read({ ...root, innerText: "script secret" } as Node);
    expect(result.text).toBe("Visible result");
    expect(result.sourceTruncated).toBe(false);
  });

  it("bounds large text and still includes visible descendants overriding visibility", () => {
    expect(
      read(element("DIV", [text("x".repeat(20000))])).text.length,
    ).toBeLessThanOrEqual(16001);
    expect(
      read(element("DIV", [text("x".repeat(20000))])).sourceTruncated,
    ).toBe(true);
    const root = element(
      "DIV",
      [text("hidden"), element("SPAN", [text("visible")])],
      { visibility: "hidden" },
    );
    expect(read(root).text).toBe("visible");
  });
});

describe("shipped compound page predicate", () => {
  const matches = (
    expected: Record<string, string>,
    href = "https://example.test/results?q=one",
    title = "Results",
  ) =>
    vm.runInNewContext(
      script("pub fn script", { expected: JSON.stringify(expected) }),
      {
        location: { href },
        document: {
          readyState: "complete",
          title,
          body: element("BODY", [
            text("Result ready"),
            element("SCRIPT", [text("hidden payload")]),
          ]),
        },
        getComputedStyle: styles,
      },
    );

  it("requires URL, exact normalized title, and readable text together", () => {
    expect(
      matches({
        url: "*results?q=*",
        title: " Results ",
        text: "Result   ready",
      }),
    ).toBe(true);
    expect(matches({ url: "*results*", title: "Old results" })).toBe(false);
    expect(matches({ text: "hidden payload" })).toBe(false);
    expect(matches({ url: "https://example.test/" })).toBe(false);
  });

  it("matches literal URL punctuation without treating it as a regular expression", () => {
    expect(matches({ url: "*q=one" })).toBe(true);
    expect(matches({ url: "*q=o.e" })).toBe(false);
    expect(matches({ url: "*q=one*one" })).toBe(false);
    expect(matches({ url: "https://example.test/results?q=one" })).toBe(true);
  });
  it("does not accept hidden slot fallback as visible readiness text", () => {
    const run = (text: string) =>
      vm.runInNewContext(
        script("pub fn script", { expected: JSON.stringify({ text }) }),
        {
          document: { readyState: "complete", body: slottedFixture().host },
          getComputedStyle: styles,
        },
      );
    expect(run("fallback secret")).toBe(false);
    expect(run("unassigned secret")).toBe(false);
    expect(run("assigned result")).toBe(true);
  });
});

describe("shipped input guard", () => {
  function guarded(value: string, changedOnFocus = false, connected = true) {
    const root: { activeElement: unknown } = { activeElement: null };
    const el = {
      value,
      isConnected: connected,
      getAttribute: (key: string) => (key === "data-anbo-gen" ? "gen-4" : null),
      focus() {
        root.activeElement = el;
        if (changedOnFocus) el.value = "reset";
      },
      getRootNode: () => root,
      contains: () => false,
    };
    const body = script("pub fn input_guard_body", {
      generation: "4",
      expected: JSON.stringify("requested"),
    });
    return JSON.parse(vm.runInNewContext(`(() => {${body}})()`, { el }));
  }
  it("accepts a matching input and rejects values changed before or during focus", () => {
    expect(guarded("requested")).toEqual({ ok: true });
    expect(guarded("reset")).toEqual({ ok: false, error: "input_mismatch" });
    expect(guarded("requested", true)).toEqual({
      ok: false,
      error: "input_mismatch",
    });
    expect(guarded("requested", false, false)).toEqual({
      ok: false,
      error: "stale_ref",
    });
    expect(JSON.stringify(guarded("private value"))).not.toContain(
      "private value",
    );
  });
});
