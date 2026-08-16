import { beforeEach, describe, expect, it, vi } from "vitest";

const { toast, shortcutLabel } = vi.hoisted(() => ({
  toast: vi.fn(),
  shortcutLabel: vi.fn(() => "Ctrl+Shift+A"),
}));

vi.mock("sonner", () => ({ toast }));
vi.mock("@/modules/shortcuts", () => ({ shortcutLabel }));

import { showAgentToast } from "./AgentToast";

describe("showAgentToast", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps a title-only alert on one compact row", () => {
    showAgentToast({
      agent: "claude",
      title: "Aurelia needs your input",
      onActivate: vi.fn(),
    });

    expect(toast).toHaveBeenCalledWith(
      "Aurelia needs your input",
      expect.objectContaining({ description: undefined }),
    );
  });

  it("keeps the shortcut alongside a real description", () => {
    showAgentToast({
      agent: "claude",
      title: "Aurelia needs your input",
      body: "Workspace task",
      onActivate: vi.fn(),
    });

    const options = toast.mock.calls[0]?.[1];
    expect(options?.description).toBeTruthy();
  });
});
