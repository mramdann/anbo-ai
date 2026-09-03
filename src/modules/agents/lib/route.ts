import { usePreferencesStore } from "@/modules/settings/preferences";
import { showAgentToast } from "../components/AgentToast";
import { useAgentStore } from "../store/agentStore";
import { displayAgent, displayAgentInstance } from "./format";
import { osNotify } from "./notify";
import type { AgentSource, NotificationKind } from "./types";

type RouteArgs = {
  source: AgentSource;
  agent: string;
  name?: string;
  kind: NotificationKind;
  title: string;
  body?: string;
  workspace?: string;
  focused: boolean;
  /** True when the user is currently looking at this agent. */
  visible: boolean;
  /** Allow an in-app toast when focused but not looking at the agent. */
  allowToast: boolean;
  tabId?: number;
  leafId?: number;
  onActivate: () => void;
};

export function routeAgentNotification({
  source,
  agent,
  name,
  kind,
  title,
  body,
  workspace,
  focused,
  visible,
  allowToast,
  tabId = 0,
  leafId = 0,
  onActivate,
}: RouteArgs): void {
  if (focused && visible) return;
  const preferences = usePreferencesStore.getState();
  const inAppEnabled = preferences.agentInAppNotifications;
  const systemEnabled = preferences.agentSystemNotifications;

  if (inAppEnabled) {
    const displayName = displayAgentInstance(agent, name);
    if (kind !== "attention") {
      useAgentStore.getState().pushNotification({
        source,
        agent,
        name: displayName,
        kind,
        tabId,
        leafId,
      });
    }
    if (allowToast) {
      showAgentToast({ agent, title, body, workspace, onActivate });
    }
  }

  if (systemEnabled && !focused) {
    void osNotify(
      title,
      [displayAgent(agent), workspace, body].filter(Boolean).join(" · "),
    );
  }
}
