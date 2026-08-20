import { beforeEach, describe, expect, it, vi } from "vitest";

const { toast, shortcutLabel, playAttentionSound } = vi.hoisted(() => ({
  toast: vi.fn(),
  shortcutLabel: vi.fn(() => "Ctrl+Shift+A"),
  playAttentionSound: vi.fn(),
}));

vi.mock("sonner", () => ({ toast }));
vi.mock("@/modules/shortcuts", () => ({ shortcutLabel }));
vi.mock("../lib/attentionSound", () => ({ playAttentionSound }));

import { renderToStaticMarkup } from "react-dom/server";
import { showAgentToast } from "./AgentToast";

describe("showAgentToast", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("identifies the agent below the alert title", async () => {
    showAgentToast({
      agent: "claude",
      title: "Aurelia needs your input",
      onActivate: vi.fn(),
    });

    const description = toast.mock.calls[0]?.[1]?.description;
    expect(renderToStaticMarkup(description)).toContain("Claude Code");
    await vi.waitFor(() =>
      expect(playAttentionSound).toHaveBeenCalledTimes(1),
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
    expect(options?.duration).toBe(30_000);
  });

  it("shows the agent before the originating workspace", () => {
    showAgentToast({
      agent: "claude",
      title: "Aurelia needs your input",
      workspace: "notaris-surat",
      onActivate: vi.fn(),
    });

    const description = toast.mock.calls[0]?.[1]?.description;
    expect(renderToStaticMarkup(description)).toContain(
      "Claude Code · notaris-surat",
    );
  });

  it("invokes onActivate and prevents default when action is clicked", () => {
    const onActivate = vi.fn();
    showAgentToast({
      agent: "claude",
      title: "Aurelia needs your input",
      onActivate,
    });

    const action = toast.mock.calls[0]?.[1]?.action;
    expect(action?.label).toBe("Open");
    const preventDefault = vi.fn();
    action?.onClick?.({ preventDefault } as unknown as React.MouseEvent);
    expect(preventDefault).toHaveBeenCalled();
    expect(onActivate).toHaveBeenCalledTimes(1);
  });
});
