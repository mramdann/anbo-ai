import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

const source = readFileSync(
  new URL(
    "../../../src-tauri/src/modules/browser_automation/hoverObservation.js",
    import.meta.url,
  ),
  "utf8",
);

function harness() {
  const listeners = new Map<string, (event: unknown) => void>();
  const timers = new Map<number, () => void>();
  let id = 0;
  const win = {
    addEventListener: vi.fn((type, listener) => listeners.set(type, listener)),
    removeEventListener: vi.fn((type) => listeners.delete(type)),
  };
  const element = {
    isConnected: true,
    matches: vi.fn(() => false),
    ownerDocument: { defaultView: win },
  };
  const context = vm.createContext({
    element,
    setTimeout: (callback: () => void) => {
      timers.set(++id, callback);
      return id;
    },
    clearTimeout: (key: number) => timers.delete(key),
  });
  vm.runInContext(source, context);
  const begin = () =>
    vm.runInContext(
      "beginHoverObservation(element, 'g1-e1', {x:20,y:30})",
      context,
    );
  const take = (ref = "g1-e1") =>
    vm.runInContext(
      `globalThis.__anboHoverObservation?.take(${JSON.stringify(ref)})`,
      context,
    );
  const event = (overrides = {}) =>
    listeners.get("pointerover")?.({
      isTrusted: true,
      clientX: 20,
      clientY: 30,
      composedPath: () => [element],
      ...overrides,
    });
  begin();
  return { element, context, listeners, timers, begin, take, event };
}

describe("action-scoped native hover observation", () => {
  it("recognizes delivered input when its handler removes the target", () => {
    const h = harness();
    h.event();
    h.element.isConnected = false;
    expect(h.take()).toMatchObject({
      ok: true,
      eventVerified: true,
      connected: false,
      cssHover: false,
    });
    expect(h.listeners.size + h.timers.size).toBe(0);
    expect(h.take()).toBeUndefined();
  });

  it("recognizes delivered input when a hover handler moves or covers the target", () => {
    const h = harness();
    h.event();
    expect(h.take()).toMatchObject({
      ok: true,
      eventVerified: true,
      connected: true,
      cssHover: false,
    });
  });

  it.each([{ isTrusted: false }, { clientX: 200 }, { clientY: Number.NaN }])(
    "never accepts unrelated or synthetic events: %j",
    (event) => {
      const h = harness();
      h.event(event);
      expect(h.take()).toMatchObject({
        ok: false,
        eventVerified: false,
        error: "hover_not_observed",
      });
    },
  );

  it("keeps a wrong-target first event rejected, even if CSS hover is true", () => {
    const h = harness();
    h.event({ composedPath: () => [{}] });
    h.event();
    h.element.matches.mockReturnValue(true);
    expect(h.take()).toMatchObject({
      ok: false,
      eventVerified: false,
      error: "hover_intercepted",
    });
  });

  it("retains CSS verification for coalesced movement with no delivered event", () => {
    const h = harness();
    h.element.matches.mockReturnValue(true);
    expect(h.take()).toMatchObject({
      ok: true,
      eventVerified: false,
      cssHover: true,
    });
  });

  it("includes shadow descendants via the composed path", () => {
    const h = harness();
    h.event({ composedPath: () => [{}, h.element, {}] });
    expect(h.take()).toHaveProperty("eventVerified", true);
  });

  it("does not consume another ref's observation", () => {
    const h = harness();
    h.event();
    expect(h.take("g2-e1")).toBeNull();
    expect(h.take()).toHaveProperty("eventVerified", true);
  });

  it("expires abandoned listeners and timers without dispatching any input", () => {
    const h = harness();
    for (const callback of h.timers.values()) callback();
    expect(h.listeners.size + h.timers.size).toBe(0);
    expect(h.take()).toBeUndefined();
  });

  it("replaces the previous observation and clears its event evidence", () => {
    const h = harness();
    h.event();
    h.begin();
    expect(h.listeners.size).toBe(4);
    expect(h.timers.size).toBe(1);
    expect(h.take()).toHaveProperty("ok", false);
  });

  it("refuses a detached target before any listener is installed", () => {
    const h = harness();
    h.element.isConnected = false;
    expect(h.begin).toThrow("detached before dispatch");
    expect(h.listeners.size + h.timers.size).toBe(0);
  });
});
