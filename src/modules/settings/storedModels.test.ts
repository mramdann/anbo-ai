import { beforeEach, describe, expect, it, vi } from "vitest";

const stored = vi.hoisted(() => ({ entries: [] as [string, unknown][] }));

vi.mock("@/lib/localStore", () => ({
  LocalLazyStore: class {
    entries() {
      return Promise.resolve(stored.entries);
    }
    get() {
      return Promise.resolve(undefined);
    }
    set() {
      return Promise.resolve();
    }
    save() {
      return Promise.resolve();
    }
    onChange() {
      return Promise.resolve(() => {});
    }
  },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn(), listen: vi.fn() }));

import { loadPreferences } from "./store";

describe("stored model choices", () => {
  beforeEach(() => {
    stored.entries = [];
  });

  it("keeps a custom endpoint's model in favorites and recents across a restart", async () => {
    stored.entries = [
      ["favoriteModelIds", ["compat-ep1", "gpt-5.4-mini", "no-such-model"]],
      ["recentModelIds", ["compat-ep1", "openai/gpt-oss-20b"]],
    ];
    const prefs = await loadPreferences();
    expect(prefs.favoriteModelIds).toEqual(["compat-ep1", "gpt-5.4-mini"]);
    expect(prefs.recentModelIds).toEqual(["compat-ep1", "openai/gpt-oss-20b"]);
  });

  it("moves a choice of a withdrawn Groq model to its replacement", async () => {
    stored.entries = [
      ["defaultModelId", "llama-3.3-70b-versatile"],
      ["autocompleteModelId", "deepseek-r1-distill-llama-70b"],
      ["favoriteModelIds", ["llama-3.3-70b-versatile", "openai/gpt-oss-120b"]],
      ["recentModelIds", ["deepseek-r1-distill-llama-70b", "gpt-5.4-mini"]],
    ];
    const prefs = await loadPreferences();
    expect(prefs.defaultModelId).toBe("openai/gpt-oss-120b");
    expect(prefs.autocompleteModelId).toBe("openai/gpt-oss-120b");
    expect(prefs.favoriteModelIds).toEqual(["openai/gpt-oss-120b"]);
    expect(prefs.recentModelIds).toEqual([
      "openai/gpt-oss-120b",
      "gpt-5.4-mini",
    ]);
  });
});
