import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL(
    "../../../src-tauri/src/modules/browser_automation/revealBaseline.js",
    import.meta.url,
  ),
  "utf8",
);

function harness() {
  let now = 0;
  let scanned = 0;
  const attributes: Record<string, string> = {};
  const target = {
    getAttribute: (name: string): string | null => attributes[name] ?? null,
  };
  const surface = () => ({
    visible: true,
    localName: "div",
    getAttribute: () => "listbox",
  });
  const nodes = Array.from({ length: 65 }, surface);
  const context = vm.createContext({
    target,
    document: { querySelectorAll: () => nodes },
    isRenderedElement: (node: { visible: boolean }) => {
      scanned++;
      return node.visible;
    },
    Date: { now: () => now },
  });
  vm.runInContext(source, context);
  return {
    attributes,
    target,
    nodes,
    capture: () =>
      vm.runInContext("captureRevealBaseline(target)", context) as
        | number
        | null,
    read: (token: number | null, other = target) =>
      vm.runInContext(
        "readRevealBaseline(readTarget, token)",
        Object.assign(context, { readTarget: other, token }),
      ),
    elapse: (ms: number) => {
      now += ms;
    },
    scans: () => scanned,
  };
}

describe("pre-input reveal baseline", () => {
  it("caps scans and refuses to claim complete coverage when capped", () => {
    const h = harness();
    const baseline = h.read(h.capture());
    expect(h.scans()).toBe(64);
    expect(baseline.complete).toBe(false);
    expect(baseline.nodes.has(h.nodes[63])).toBe(true);
    expect(baseline.nodes.has(h.nodes[64])).toBe(false);
    expect(baseline.target.deref()).toBe(h.target);
  });

  it("retains only the latest token for the same input identity", () => {
    const h = harness();
    const old = h.capture();
    const current = h.capture();
    expect(h.read(old)).toBeNull();
    expect(h.read(current)).not.toBeNull();
    expect(h.read(current, { getAttribute: () => null })).toBeNull();
    expect(h.read(null)).toBeNull();
    h.elapse(10001);
    expect(h.read(current)).toBeNull();
  });

  it("does not scan unrelated surfaces for a declared relationship", () => {
    const h = harness();
    h.attributes["aria-controls"] = "late-list";
    expect(h.capture()).toBeNull();
    expect(h.scans()).toBe(0);
  });

  it("records only surfaces visible before the action", () => {
    const h = harness();
    h.nodes.splice(2);
    h.nodes[1].visible = false;
    const baseline = h.read(h.capture());
    h.nodes[1].visible = true;
    expect(baseline.complete).toBe(true);
    expect(baseline.nodes.has(h.nodes[0])).toBe(true);
    expect(baseline.nodes.has(h.nodes[1])).toBe(false);
  });
});
