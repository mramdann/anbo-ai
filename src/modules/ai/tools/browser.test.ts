import type { ToolExecutionOptions } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "./context";

const invokeMock = vi.hoisted(() => vi.fn(async () => "{}"));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { buildBrowserTools } from "./browser";

const toolOptions: ToolExecutionOptions = {
  toolCallId: "tool-call",
  messages: [],
};

function makeContext(
  tabId: number | null,
  navigatePreview: (url: string) => boolean = () => false,
): ToolContext {
  return {
    getCwd: () => null,
    getWorkspaceRoot: () => null,
    getTerminalContext: () => null,
    isActiveTerminalPrivate: () => false,
    injectIntoActivePty: () => false,
    openPreview: () => false,
    navigatePreview,
    getActivePreviewTabId: () => tabId,
    spawnAgent: () => null,
    readAgentOutput: () => null,
    readCache: new Map(),
    getSessionId: () => "session",
  };
}

async function run(
  toolName: keyof ReturnType<typeof buildBrowserTools>,
  input: Record<string, unknown>,
) {
  const execute = buildBrowserTools(makeContext(42))[toolName].execute;
  if (!execute) throw new Error(`${toolName} has no execute`);
  return execute(input as never, toolOptions);
}

describe("AI browser tools", () => {
  beforeEach(() => vi.clearAllMocks());

  it("targets the active preview with snapshot refs", async () => {
    await run("browser_click", { ref: "e7" });

    expect(invokeMock).toHaveBeenCalledWith(
      "browser_automation_handle_action",
      {
        requestJson: JSON.stringify({ action: "click", tabId: 42, ref: "e7" }),
      },
    );
  });

  it("does not invoke the backend without an active preview", async () => {
    const execute = buildBrowserTools(makeContext(null)).browser_snapshot.execute;
    if (!execute) throw new Error("browser_snapshot has no execute");

    await expect(execute({}, toolOptions)).resolves.toEqual({
      status: "error",
      error: "Error: no active browser preview tab",
    });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("routes external navigation through the preview lifecycle", async () => {
    const navigatePreview = vi.fn(() => true);
    const execute = buildBrowserTools(
      makeContext(null, navigatePreview),
    ).browser_navigate.execute;
    if (!execute) throw new Error("browser_navigate has no execute");

    await expect(
      execute({ url: "https://www.youtube.com" }, toolOptions),
    ).resolves.toEqual({
      status: "ok",
      opened: true,
      url: "https://www.youtube.com",
    });
    expect(navigatePreview).toHaveBeenCalledWith("https://www.youtube.com");
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
