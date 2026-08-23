import type { ToolExecutionOptions } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "./context";

const invokeMock = vi.hoisted(() =>
  vi.fn(async (_command: string, _args: { requestJson: string }) => "{}"),
);

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { buildBrowserTools } from "./browser";

const toolOptions: ToolExecutionOptions = {
  toolCallId: "tool-call",
  messages: [],
};

function makeContext(
  tabId: number | null,
  browser: {
    navigateBrowser?: (url: string) => boolean;
    openBrowser?: (url: string) => boolean;
    switchBrowserTab?: (tabId: number) => boolean;
    closeBrowserTab?: (tabId: number) => boolean;
  } = {},
): ToolContext {
  return {
    getCwd: () => null,
    getWorkspaceRoot: () => null,
    getWorkspaceEnv: () => ({ kind: "local" }),
    getTerminalContext: () => null,
    isActiveTerminalPrivate: () => false,
    injectIntoActivePty: () => false,
    openBrowser: browser.openBrowser ?? (() => false),
    navigateBrowser: browser.navigateBrowser ?? (() => false),
    switchBrowserTab: browser.switchBrowserTab ?? (() => false),
    closeBrowserTab: browser.closeBrowserTab ?? (() => false),
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

  it("finds a role by accessible name with bounded output", async () => {
    await run("browser_find", {
      by: "role",
      value: "button",
      name: "Save",
      exact: true,
      includeHidden: false,
      limit: 3,
      timeout: 2500,
    });

    expect(invokeMock).toHaveBeenCalledWith(
      "browser_automation_handle_action",
      {
        requestJson: JSON.stringify({
          action: "find",
          tabId: 42,
          by: "role",
          value: "button",
          name: "Save",
          exact: true,
          includeHidden: false,
          limit: 3,
          timeout: 2500,
        }),
      },
    );
  });

  it("routes complex element and keyboard actions to the same active tab", async () => {
    await run("browser_check", { ref: "g4-e2", checked: true });
    await run("browser_drag", {
      sourceRef: "g4-e3",
      targetRef: "g4-e4",
    });
    await run("browser_keyboard", {
      key: "a",
      keyAction: "press",
      modifiers: ["Control"],
    });

    expect(
      invokeMock.mock.calls.map((call) => JSON.parse(call[1].requestJson)),
    ).toEqual([
      { action: "check", tabId: 42, ref: "g4-e2", checked: true },
      {
        action: "drag",
        tabId: 42,
        sourceRef: "g4-e3",
        targetRef: "g4-e4",
      },
      {
        action: "key",
        tabId: 42,
        key: "a",
        keyAction: "press",
        modifiers: ["Control"],
      },
    ]);
  });

  it("passes richer wait and dialog contracts without overloading action", async () => {
    await run("browser_wait", {
      condition: "ref",
      ref: "g5-e7",
      state: "visible",
      timeout: 3000,
    });
    await run("browser_dialog", {
      ref: "g5-e8",
      dialogAction: "accept",
      promptText: "Anbo",
    });

    expect(JSON.parse(invokeMock.mock.calls[0][1].requestJson)).toEqual({
      action: "wait",
      tabId: 42,
      condition: "ref",
      ref: "g5-e7",
      state: "visible",
      timeout: 3000,
    });
    expect(JSON.parse(invokeMock.mock.calls[1][1].requestJson)).toEqual({
      action: "dialog",
      tabId: 42,
      ref: "g5-e8",
      dialogAction: "accept",
      promptText: "Anbo",
    });
  });

  it("does not invoke the backend without an active browser tab", async () => {
    const execute = buildBrowserTools(makeContext(null)).browser_snapshot
      .execute;
    if (!execute) throw new Error("browser_snapshot has no execute");

    await expect(execute({}, toolOptions)).resolves.toEqual({
      status: "error",
      error: "Error: no active browser tab",
    });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("routes external navigation through the browser lifecycle", async () => {
    const navigateBrowser = vi.fn(() => true);
    const execute = buildBrowserTools(makeContext(null, { navigateBrowser }))
      .browser_navigate.execute;
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
          workspace: null,
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

  it("selects a dropdown option by ref", async () => {
    await run("browser_select_option", { ref: "e3", value: "Indonesia" });

    expect(invokeMock).toHaveBeenCalledWith(
      "browser_automation_handle_action",
      {
        requestJson: JSON.stringify({
          action: "select_option",
          tabId: 42,
          ref: "e3",
          value: "Indonesia",
        }),
      },
    );
  });

  it("hovers an element by ref", async () => {
    await run("browser_hover", { ref: "e2" });

    expect(invokeMock).toHaveBeenCalledWith(
      "browser_automation_handle_action",
      {
        requestJson: JSON.stringify({ action: "hover", tabId: 42, ref: "e2" }),
      },
    );
  });

  it("scrolls an element into view by ref", async () => {
    await run("browser_scroll_to_element", { ref: "e9" });

    expect(invokeMock).toHaveBeenCalledWith(
      "browser_automation_handle_action",
      {
        requestJson: JSON.stringify({
          action: "scroll_to_element",
          tabId: 42,
          ref: "e9",
        }),
      },
    );
  });

  it("reads text of a specific element", async () => {
    await run("browser_get_text", { ref: "e5" });

    expect(invokeMock).toHaveBeenCalledWith(
      "browser_automation_handle_action",
      {
        requestJson: JSON.stringify({
          action: "get_text",
          tabId: 42,
          ref: "e5",
          maxLength: 8000,
        }),
      },
    );
  });

  it("reads whole-page text with the default max length", async () => {
    await run("browser_get_text", {});

    expect(invokeMock).toHaveBeenCalledWith(
      "browser_automation_handle_action",
      {
        requestJson: JSON.stringify({
          action: "get_text",
          tabId: 42,
          maxLength: 8000,
        }),
      },
    );
  });

  it("gets the page title and url", async () => {
    await run("browser_get_page_info", {});

    expect(invokeMock).toHaveBeenCalledWith(
      "browser_automation_handle_action",
      {
        requestJson: JSON.stringify({ action: "get_page_info", tabId: 42 }),
      },
    );
  });

  it("lists all browser tabs without needing an active tab", async () => {
    await run("browser_list_tabs", {});

    expect(invokeMock).toHaveBeenCalledWith(
      "browser_automation_handle_action",
      {
        requestJson: JSON.stringify({ action: "list_tabs" }),
      },
    );
  });

  it("opens a new browser tab via the browser lifecycle", async () => {
    const openBrowser = vi.fn(() => true);
    const execute = buildBrowserTools(makeContext(null, { openBrowser }))
      .browser_new_tab.execute;
    if (!execute) throw new Error("browser_new_tab has no execute");

    await expect(
      execute({ url: "https://example.com" }, toolOptions),
    ).resolves.toEqual({
      status: "ok",
      opened: true,
      url: "https://example.com",
    });
    expect(openBrowser).toHaveBeenCalledWith("https://example.com");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("switches the active browser tab by id", async () => {
    const switchBrowserTab = vi.fn(() => true);
    const execute = buildBrowserTools(makeContext(42, { switchBrowserTab }))
      .browser_switch_tab.execute;
    if (!execute) throw new Error("browser_switch_tab has no execute");

    await expect(execute({ tabId: 7 }, toolOptions)).resolves.toEqual({
      status: "ok",
      activeTabId: 7,
    });
    expect(switchBrowserTab).toHaveBeenCalledWith(7);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("closes a browser tab by id", async () => {
    const closeBrowserTab = vi.fn(() => true);
    const execute = buildBrowserTools(makeContext(42, { closeBrowserTab }))
      .browser_close_tab.execute;
    if (!execute) throw new Error("browser_close_tab has no execute");

    await expect(execute({ tabId: 9 }, toolOptions)).resolves.toEqual({
      status: "ok",
      closed: true,
      tabId: 9,
    });
    expect(closeBrowserTab).toHaveBeenCalledWith(9);
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
