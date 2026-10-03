import { useChatStore } from "@/modules/ai/store/chatStore";
import { usePreferencesStore } from "@/modules/settings/preferences";
import type { LocalProviderConfig } from "./agent";

/**
 * The local and custom endpoint settings a model is built with, read now. For
 * models built outside the chat transport, which gets the same values through
 * its own getters: a copy that leaves a field out builds a different model, as
 * the commit message generator did with custom endpoints.
 */
export function currentLocalProviderConfig(): LocalProviderConfig {
  const preferences = usePreferencesStore.getState();
  return {
    lmstudioBaseURL: preferences.lmstudioBaseURL,
    lmstudioModelId: preferences.lmstudioModelId,
    mlxBaseURL: preferences.mlxBaseURL,
    mlxModelId: preferences.mlxModelId,
    ollamaBaseURL: preferences.ollamaBaseURL,
    ollamaModelId: preferences.ollamaModelId,
    openaiCompatibleBaseURL: preferences.openaiCompatibleBaseURL,
    openaiCompatibleModelId: preferences.openaiCompatibleModelId,
    openrouterModelId: preferences.openrouterModelId,
    customEndpoints: preferences.customEndpoints,
    customEndpointKeys: useChatStore.getState().customEndpointKeys,
  };
}
