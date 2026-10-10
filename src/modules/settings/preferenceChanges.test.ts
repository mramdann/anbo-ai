import { describe, expect, it, vi } from "vitest";

const events = vi.hoisted(() => ({
  handlers: new Map<string, (event: { payload: unknown }) => void>(),
}));

// The store has no onChange: listening there would get every store change of
// the app in this window.
vi.mock("@/lib/localStore", () => ({ LocalLazyStore: class {} }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(),
  listen: vi.fn(
    (name: string, handler: (event: { payload: unknown }) => void) => {
      events.handlers.set(name, handler);
      return Promise.resolve(() => {});
    },
  ),
}));

import { listen } from "@tauri-apps/api/event";
import { onPreferencesChange } from "./store";

describe("preference changes", () => {
  it("reach the browser automation switch, so it shows what was set", async () => {
    // Without this key the switch kept showing the value it loaded with, and
    // every later click sent that same value again.
    const changes: [string, unknown][] = [];
    await onPreferencesChange((key, value) => changes.push([key, value]));
    events.handlers.get("anbo://prefs-changed")?.({
      payload: { key: "browserAutomationEnabled", value: false },
    });
    expect(changes).toEqual([["browserAutomationEnabled", false]]);
  });

  it("come from the settings event alone, not from every store change of the app", async () => {
    vi.mocked(listen).mockClear();
    await onPreferencesChange(() => {});
    expect(vi.mocked(listen).mock.calls.map(([name]) => name)).toEqual([
      "anbo://prefs-changed",
    ]);
  });
});
