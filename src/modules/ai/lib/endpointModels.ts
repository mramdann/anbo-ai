import {
  type CustomEndpoint,
  compatModelIdForEndpoint,
  DEFAULT_MODEL_ID,
  isCompatModelId,
} from "@/modules/ai/config";
import { useChatStore } from "@/modules/ai/store/chatStore";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  setDefaultModel,
  setFavoriteModelIds,
  setRecentModelIds,
} from "@/modules/settings/store";

/**
 * Forget the models of custom endpoints that are gone, in the window this
 * runs in. An endpoint is removed in the Settings window, but the chat
 * selection lives in the main window, which kept pointing at the removed
 * endpoint (shown as "Custom endpoint", failing the next send) and wrote its
 * id back into the recents; a default model left on it did the same at every
 * start.
 */
export async function dropRemovedEndpointModels(
  endpoints: readonly CustomEndpoint[],
): Promise<void> {
  const live = new Set(
    endpoints.map((endpoint) => compatModelIdForEndpoint(endpoint.id)),
  );
  const removed = (id: string) => isCompatModelId(id) && !live.has(id);
  const { favoriteModelIds, recentModelIds, defaultModelId } =
    usePreferencesStore.getState();
  if (favoriteModelIds.some(removed)) {
    await setFavoriteModelIds(favoriteModelIds.filter((id) => !removed(id)));
  }
  if (recentModelIds.some(removed)) {
    await setRecentModelIds(recentModelIds.filter((id) => !removed(id)));
  }
  if (removed(defaultModelId)) await setDefaultModel(DEFAULT_MODEL_ID);
  // Set directly: setSelectedModelId would push the fallback onto recents
  // read before the write above lands, and bring the removed id back.
  if (removed(useChatStore.getState().selectedModelId)) {
    useChatStore.setState({
      selectedModelId: endpoints[0]
        ? compatModelIdForEndpoint(endpoints[0].id)
        : DEFAULT_MODEL_ID,
    });
  }
}
