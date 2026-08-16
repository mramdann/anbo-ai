import { beforeEach, describe, expect, it, vi } from "vitest";

const { pushNotification, osNotify, showAgentToast } = vi.hoisted(() => ({
  pushNotification: vi.fn(),
  osNotify: vi.fn(),
  showAgentToast: vi.fn(),
}));

vi.mock("@/modules/settings/preferences", () => ({
  usePreferencesStore: {
    getState: () => ({ agentNotifications: true }),
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
      }),
    );
  });
});
