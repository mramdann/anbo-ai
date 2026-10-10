import { describe, expect, it, vi } from "vitest";

const events = vi.hoisted(() => ({
  handlers: new Map<string, () => void>(),
}));

// The store has no onChange: listening there would get every store change of
// the app in this window.
vi.mock("@/lib/localStore", () => ({
  LocalLazyStore: class {
    private readonly data = new Map<string, unknown>();
    async get(key: string) {
      return this.data.get(key);
    }
    async set(key: string, value: unknown) {
      this.data.set(key, value);
    }
    async save() {}
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(async (name: string) => events.handlers.get(name)?.()),
  listen: vi.fn(async (name: string, handler: () => void) => {
    events.handlers.set(name, handler);
    return () => {};
  }),
}));

import { listen } from "@tauri-apps/api/event";
import {
  deleteCustomTheme,
  listCustomThemes,
  onCustomThemesChange,
  saveCustomTheme,
} from "./customThemes";
import type { Theme } from "./types";

describe("custom theme changes", () => {
  it("come from the theme event alone, which saving and deleting send", async () => {
    const changed = vi.fn();
    await onCustomThemesChange(changed);
    expect(vi.mocked(listen).mock.calls.map(([name]) => name)).toEqual([
      "anbo://custom-themes-changed",
    ]);
    await saveCustomTheme({ id: "mine", name: "Mine" } as Theme);
    expect(changed).toHaveBeenCalledTimes(1);
    expect((await listCustomThemes()).map((theme) => theme.id)).toEqual([
      "mine",
    ]);
    await deleteCustomTheme("mine");
    expect(changed).toHaveBeenCalledTimes(2);
    await deleteCustomTheme("absent");
    expect(changed).toHaveBeenCalledTimes(2);
  });
});
