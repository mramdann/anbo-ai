import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL(
    "../../../src-tauri/src/modules/browser_automation/locator.rs",
    import.meta.url,
  ),
  "utf8",
);
const extracted = source.match(
  /pub const PAGE_SCAN_STATE_JS: &str = r#"([\s\S]*?)"#/,
)?.[1];
if (!extracted) throw new Error("Page scan state script missing");
const script = extracted;

function fixture(failObserve = false) {
  let clock = 0;
  let timerId = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const observers: Observer[] = [];
  class Observer {
    disconnected = false;
    target: unknown;
    constructor(public callback: (records: unknown[]) => void) {
      observers.push(this);
    }
    observe(target: unknown) {
      if (failObserve) throw new Error("unavailable");
      this.target = target;
    }
    disconnect() {
      this.disconnected = true;
    }
  }
  const document = { getAnimations: () => [] };
  const context = vm.createContext({
    window: {},
    document,
    MutationObserver: Observer,
    performance: { now: () => clock },
    setTimeout(callback: () => void, ms: number) {
      const id = ++timerId;
      timers.set(id, { at: clock + ms, callback });
      return id;
    },
  });
  const advance = (target: number) => {
    while (true) {
      const next = [...timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      clock = next[1].at;
      timers.delete(next[0]);
      next[1].callback();
    }
    clock = target;
  };
  return {
    observers,
    timers,
    document,
    advance,
    read: () =>
      JSON.parse(vm.runInContext(script, context)) as {
        id: string;
        mutations: number;
        animating: boolean;
      },
  };
}

describe("shipped locator observation lifecycle", () => {
  it("is lazy and shares one observer and one timer across reads", () => {
    const f = fixture();
    expect(f.observers).toHaveLength(0);
    expect(f.timers.size).toBe(0);
    const first = f.read();
    for (let i = 0; i < 100; i++) expect(f.read()).toEqual(first);
    expect(f.observers).toHaveLength(1);
    expect(f.observers[0].target).toBe(f.document);
    expect(f.timers.size).toBe(1);
  });

  it("disconnects after inactivity and never polls an idle page", () => {
    const f = fixture();
    const first = f.read();
    f.observers[0].callback([{}, {}]);
    expect(f.read().mutations).toBe(2);
    f.advance(1999);
    expect(f.observers[0].disconnected).toBe(false);
    f.advance(2000);
    expect(f.observers[0].disconnected).toBe(true);
    expect(f.timers.size).toBe(0);
    f.advance(10000);
    expect(f.observers).toHaveLength(1);
    const next = f.read();
    expect(next.id).not.toBe(first.id);
    expect(next.mutations).toBe(0);
    expect(f.observers).toHaveLength(2);
    expect(f.timers.size).toBe(1);
  });

  it("extends active observation without accumulating timers", () => {
    const f = fixture();
    const first = f.read();
    f.advance(1900);
    expect(f.read().id).toBe(first.id);
    f.advance(2000);
    expect(f.observers[0].disconnected).toBe(false);
    expect(f.timers.size).toBe(1);
    f.advance(3900);
    expect(f.observers[0].disconnected).toBe(true);
    expect(f.timers.size).toBe(0);
  });

  it("never treats unavailable observation as a stable revision", () => {
    const f = fixture(true);
    expect(f.read().mutations).toBe(-1);
    expect(f.timers.size).toBe(0);
  });
});
