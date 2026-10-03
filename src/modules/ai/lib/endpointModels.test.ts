import { beforeEach, describe, expect, it, vi } from "vitest";

const settings = vi.hoisted(() => ({
  setDefaultModel: vi.fn(async () => {}),
  setFavoriteModelIds: vi.fn(async () => {}),
  setRecentModelIds: vi.fn(async () => {}),
}));
vi.mock("@/modules/settings/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/modules/settings/store")>()),
  ...settings,
}));

import { DEFAULT_MODEL_ID } from "@/modules/ai/config";
import { useChatStore } from "@/modules/ai/store/chatStore";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { dropRemovedEndpointModels } from "./endpointModels";

const kept = {
  id: "kept",
  name: "Kept",
  baseURL: "http://127.0.0.1:1/v1",
  modelId: "m",
  contextLimit: 128_000,
};

describe("dropRemovedEndpointModels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("moves every reference off a removed endpoint and keeps the rest", async () => {
    usePreferencesStore.setState({
      favoriteModelIds: ["compat-gone", "gpt-5.4-mini"],
      recentModelIds: ["compat-gone", "compat-kept", "gpt-5.4-mini"],
      defaultModelId: "compat-gone",
    });
    useChatStore.setState({ selectedModelId: "compat-gone" });

    await dropRemovedEndpointModels([kept]);

    expect(settings.setFavoriteModelIds).toHaveBeenCalledWith(["gpt-5.4-mini"]);
    expect(settings.setRecentModelIds).toHaveBeenCalledWith([
      "compat-kept",
      "gpt-5.4-mini",
    ]);
    expect(settings.setDefaultModel).toHaveBeenCalledWith(DEFAULT_MODEL_ID);
    expect(useChatStore.getState().selectedModelId).toBe("compat-kept");
  });

  it("falls back to the default model and writes nothing when nothing is stale", async () => {
    usePreferencesStore.setState({
      favoriteModelIds: [],
      recentModelIds: ["gpt-5.4-mini"],
      defaultModelId: "gpt-5.4-mini",
    });
    useChatStore.setState({ selectedModelId: "compat-gone" });

    await dropRemovedEndpointModels([]);

    expect(useChatStore.getState().selectedModelId).toBe(DEFAULT_MODEL_ID);
    expect(settings.setFavoriteModelIds).not.toHaveBeenCalled();
    expect(settings.setRecentModelIds).not.toHaveBeenCalled();
    expect(settings.setDefaultModel).not.toHaveBeenCalled();
  });
});
