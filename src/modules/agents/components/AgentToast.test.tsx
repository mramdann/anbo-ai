import { beforeEach, describe, expect, it, vi } from "vitest";

const { toast, shortcutLabel } = vi.hoisted(() => ({
  toast: vi.fn(),
  shortcutLabel: vi.fn(() => "Ctrl+Shift+A"),
}));

vi.mock("sonner", () => ({ toast }));
vi.mock("@/modules/shortcuts", () => ({ shortcutLabel }));

import { renderToStaticMarkup } from "react-dom/server";
import { showAgentToast } from "./AgentToast";

describe("showAgentToast", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("identifies the agent below the alert title", () => {
    showAgentToast({
      agent: "claude",
      title: "Aurelia needs your input",
      onActivate: vi.fn(),
    });

    const description = toast.mock.calls[0]?.[1]?.description;
    expect(renderToStaticMarkup(description)).toContain("Claude Code");
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
});
