import { beforeEach, describe, expect, it, vi } from "vitest";

const { preferences, pushNotification, osNotify, showAgentToast } = vi.hoisted(
  () => ({
    preferences: {
      agentInAppNotifications: true,
      agentSystemNotifications: true,
    },
    pushNotification: vi.fn(),
    osNotify: vi.fn(),
    showAgentToast: vi.fn(),
  }),
);

vi.mock("@/modules/settings/preferences", () => ({
  usePreferencesStore: {
    getState: () => preferences,
  },
}));

vi.mock("../components/AgentToast", () => ({ showAgentToast }));
vi.mock("../store/agentStore", () => ({
  useAgentStore: {
    getState: () => ({ pushNotification }),
  },
}));
vi.mock("./notify", () => ({ osNotify }));

import { routeAgentNotification } from "./route";

const base = {
  source: "terminal" as const,
  agent: "claude",
  name: "Leander",
  title: "Leander needs your input",
  workspace: "notaris-surat",
  focused: true,
  visible: false,
  allowToast: true,
  tabId: 7,
  leafId: 8,
  onActivate: vi.fn(),
};

describe("routeAgentNotification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    preferences.agentInAppNotifications = true;
    preferences.agentSystemNotifications = true;
  });

  it("uses the callsign in retained notification metadata", () => {
    routeAgentNotification({ ...base, kind: "finished" });

    expect(pushNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: "claude",
        name: "Leander",
        kind: "finished",
      }),
    );
  });

  it("does not duplicate a live needs-input state in retained history", () => {
    routeAgentNotification({ ...base, kind: "attention" });

    expect(pushNotification).not.toHaveBeenCalled();
    expect(showAgentToast).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: "claude",
        title: "Leander needs your input",
        workspace: "notaris-surat",
      }),
    );
  });

  it("puts the agent before the workspace in an OS notification", () => {
    routeAgentNotification({
      ...base,
      kind: "attention",
      focused: false,
    });

    expect(osNotify).toHaveBeenCalledWith(
      "Leander needs your input",
      "Claude Code · notaris-surat",
    );
  });

  it("keeps in-app alerts active when system notifications are disabled", () => {
    preferences.agentSystemNotifications = false;

    routeAgentNotification({
      ...base,
      kind: "attention",
      focused: false,
    });

    expect(showAgentToast).toHaveBeenCalledOnce();
    expect(osNotify).not.toHaveBeenCalled();
  });

  it("keeps system notifications active when in-app alerts are disabled", () => {
    preferences.agentInAppNotifications = false;

    routeAgentNotification({
      ...base,
      kind: "finished",
      focused: false,
    });

    expect(pushNotification).not.toHaveBeenCalled();
    expect(showAgentToast).not.toHaveBeenCalled();
    expect(osNotify).toHaveBeenCalledOnce();
  });
});
