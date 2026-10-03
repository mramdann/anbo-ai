import { describe, expect, it } from "vitest";
import { useChatStore } from "@/modules/ai/store/chatStore";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { currentLocalProviderConfig } from "./localProviderConfig";

describe("currentLocalProviderConfig", () => {
  it("carries custom endpoints and their keys with the local providers", () => {
    const endpoint = {
      id: "ep1",
      name: "Mock",
      baseURL: "http://127.0.0.1:18080/v1",
      modelId: "mock",
      contextLimit: 128_000,
    };
    usePreferencesStore.setState({
      customEndpoints: [endpoint],
      lmstudioModelId: "qwen",
    });
    useChatStore.setState({ customEndpointKeys: { ep1: "secret" } });

    expect(currentLocalProviderConfig()).toMatchObject({
      lmstudioModelId: "qwen",
      customEndpoints: [endpoint],
      customEndpointKeys: { ep1: "secret" },
    });
  });
});
