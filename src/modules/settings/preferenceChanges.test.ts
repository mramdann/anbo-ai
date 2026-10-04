import { describe, expect, it, vi } from "vitest";

const local = vi.hoisted(() => ({
  change: undefined as undefined | ((key: string, value: unknown) => void),
}));

vi.mock("@/lib/localStore", () => ({
  LocalLazyStore: class {
    onChange(callback: (key: string, value: unknown) => void) {
      local.change = callback;
      return Promise.resolve(() => {});
    }
  },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(),
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

import { onPreferencesChange } from "./store";

describe("preference changes", () => {
  it("reach the browser automation switch, so it shows what was set", async () => {
    // Without this key the switch kept showing the value it loaded with, and
    // every later click sent that same value again.
    const changes: [string, unknown][] = [];
    await onPreferencesChange((key, value) => changes.push([key, value]));
    local.change?.("browserAutomationEnabled", false);
    expect(changes).toEqual([["browserAutomationEnabled", false]]);
  });
});
