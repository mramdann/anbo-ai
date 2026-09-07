import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

const source = readFileSync(
  new URL(
    "../../../src-tauri/src/modules/browser/consoleCapture.js",
    import.meta.url,
  ),
  "utf8",
);
function fixture(rootMissing = false) {
  const levels = ["log", "info", "warn", "error", "debug", "trace", "assert"];
  const originals = Object.fromEntries(
    levels.map((level) => [level, vi.fn(() => 42)]),
  );
  const console = { ...originals };
  const callbacks: (() => void)[] = [];
  const events: Record<string, (event: unknown) => void> = {};
  const root = { setAttribute: vi.fn() };
  const document = {
    documentElement: rootMissing ? null : root,
    addEventListener: vi.fn(),
  };
  const window = {
    __anboLogs: [] as { level: string; msg: string }[],
    addEventListener: (name: string, fn: (event: unknown) => void) => {
      events[name] = fn;
    },
  };
  const context = vm.createContext({
    window,
    document,
    console,
    queueMicrotask: (fn: () => void) => callbacks.push(fn),
  });
  vm.runInContext(source, context);
  return {
    console,
    originals,
    window,
    callbacks,
    events,
    root,
    document,
    context,
  };
}
describe("shipped console capture", () => {
  it("preserves levels, calls originals exactly once, and skips truthy assertions", () => {
    const f = fixture();
    for (const level of Object.keys(f.console)) {
      const args = level === "assert" ? [false, "failed"] : [level];
      expect(Reflect.apply(f.console[level], f.console, args)).toBe(42);
      expect(f.originals[level]).toHaveBeenCalledExactlyOnceWith(...args);
    }
    Reflect.apply(f.console.assert, f.console, [true, "not-failed"]);
    expect(f.window.__anboLogs.map((item) => item.level)).toEqual(
      Object.keys(f.console),
    );
    expect(f.window.__anboLogs[f.window.__anboLogs.length - 1]?.msg).toBe(
      "Assertion failed: failed",
    );
    expect(f.callbacks).toHaveLength(1);
  });
  it("bounds bursts and safely captures cycles and throwing proxies", () => {
    const f = fixture();
    vm.runInContext(
      `for (let i=0;i<100;i++) console.warn('x'.repeat(6000));
      const cycle={}; cycle.self=cycle; console.log(cycle);
      console.log(new Proxy({}, { ownKeys(){throw Error('no')} }));`,
      f.context,
    );
    expect(f.window.__anboLogs).toHaveLength(50);
    expect(f.window.__anboLogs.every((item) => item.msg.length <= 4000)).toBe(
      true,
    );
    expect(f.window.__anboLogs[f.window.__anboLogs.length - 1]?.msg).toBe(
      "[unserializable]",
    );
    expect(f.originals.log).toHaveBeenCalledTimes(2);
    expect(f.callbacks).toHaveLength(1);
    f.callbacks[0]();
    expect(f.root.setAttribute).toHaveBeenCalledTimes(2);
  });
  it("retains runtime errors, rejections and the early-document mirror", () => {
    const f = fixture(true);
    expect(f.document.addEventListener).toHaveBeenCalledWith(
      "DOMContentLoaded",
      expect.any(Function),
      { once: true },
    );
    f.events.error({ message: "broken", filename: "fixture", lineno: 2 });
    f.events.unhandledrejection({ reason: "rejected" });
    expect(f.window.__anboLogs.map((item) => item.msg)).toEqual([
      "Uncaught broken at fixture:2:0",
      "Unhandled promise rejection: rejected",
    ]);
  });
});
