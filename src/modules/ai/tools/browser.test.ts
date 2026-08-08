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
  navigateBrowser: (url: string) => boolean = () => false,
): ToolContext {
  return {
    getCwd: () => null,
    getWorkspaceRoot: () => null,
    getTerminalContext: () => null,
    isActiveTerminalPrivate: () => false,
    injectIntoActivePty: () => false,
    openBrowser: () => false,
    navigateBrowser,
    getActiveBrowserTabId: () => tabId,
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

  it("does not invoke the backend without an active browser tab", async () => {
    const execute = buildBrowserTools(makeContext(null)).browser_snapshot.execute;
    if (!execute) throw new Error("browser_snapshot has no execute");

    await expect(execute({}, toolOptions)).resolves.toEqual({
      status: "error",
      error: "Error: no active browser tab",
    });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("routes external navigation through the browser lifecycle", async () => {
    const navigateBrowser = vi.fn(() => true);
    const execute = buildBrowserTools(
      makeContext(null, navigateBrowser),
    ).browser_navigate.execute;
    if (!execute) throw new Error("browser_navigate has no execute");

    await expect(
      execute({ url: "https://www.youtube.com" }, toolOptions),
    ).resolves.toEqual({
      status: "ok",
      opened: true,
      url: "https://www.youtube.com",
    });
    expect(navigateBrowser).toHaveBeenCalledWith("https://www.youtube.com");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("handles key press actions on the active preview", async () => {
    await run("browser_press_key", { key: "Enter" });

    expect(invokeMock).toHaveBeenCalledWith(
      "browser_automation_handle_action",
      {
        requestJson: JSON.stringify({
          action: "press_key",
          tabId: 42,
          key: "Enter",
        }),
      },
    );
  });

  it("handles waiting for text on the active preview", async () => {
    await run("browser_wait", { text: "Dashboard", timeout: 5000 });

    expect(invokeMock).toHaveBeenCalledWith(
      "browser_automation_handle_action",
      {
        requestJson: JSON.stringify({
          action: "wait",
          tabId: 42,
          text: "Dashboard",
          timeout: 5000,
        }),
      },
    );
  });

  it("handles screenshot capture on the active preview", async () => {
    await run("browser_screenshot", {});

    expect(invokeMock).toHaveBeenCalledWith(
      "browser_automation_handle_action",
      {
        requestJson: JSON.stringify({
          action: "screenshot",
          tabId: 42,
        }),
      },
    );
  });

  it("handles history navigation on the active preview", async () => {
    await run("browser_history", { action: "reload" });

    expect(invokeMock).toHaveBeenCalledWith(
      "browser_automation_handle_action",
      {
        requestJson: JSON.stringify({
          action: "reload",
          tabId: 42,
        }),
      },
    );
  });
});
