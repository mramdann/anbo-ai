import { invoke } from "@tauri-apps/api/core";
import { tool } from "ai";
import { z } from "zod";
import type { ToolContext } from "./context";

function activeBrowserTabId(ctx: ToolContext): number {
  const tabId = ctx.getActiveBrowserTabId();
  if (tabId === null) throw new Error("no active browser tab");
  return tabId;
}

export function buildBrowserTools(ctx: ToolContext) {
  return {
    browser_navigate: tool({
      description:
        "Open or navigate the native browser to any HTTP or HTTPS URL, including external sites. Opens a new browser tab when none is active.",
      inputSchema: z.object({
        url: z.string().describe("The HTTP or HTTPS URL to navigate to."),
      }),
      execute: async ({ url }) => {
        try {
          const protocol = new URL(url).protocol;
          if (protocol !== "http:" && protocol !== "https:") {
            return { status: "error", error: "only HTTP(S) URLs are allowed" };
          }
          const opened = ctx.navigateBrowser(url);
          return opened
            ? { status: "ok", opened: true, url }
            : { status: "error", error: "browser unavailable" };
        } catch (error) {
          return { status: "error", error: String(error) };
        }
      },
    }),

    browser_snapshot: tool({
      description:
        "Capture a token-lean DOM snapshot and interactive element list of the active browser page.",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const tabId = activeBrowserTabId(ctx);
          const res = await invoke<string>("browser_automation_handle_action", {
            requestJson: JSON.stringify({ action: "snapshot", tabId }),
          });
          return { status: "ok", snapshot: res };
        } catch (error) {
          return { status: "error", error: String(error) };
        }
      },
    }),

    browser_find: tool({
      description:
        "Find elements with a semantic locator and return fresh refs. Prefer role, label, placeholder, or testId over CSS.",
      inputSchema: z.object({
        by: z.enum([
          "role",
          "text",
          "label",
          "placeholder",
          "testId",
          "title",
          "alt",
          "css",
        ]),
        value: z.string(),
        name: z
          .string()
          .optional()
          .describe(
            "Optional computed accessible name when locating by role. aria-label, aria-labelledby, an associated label, alt, or title can take precedence over visible text.",
          ),
        exact: z.boolean().default(false),
        includeHidden: z.boolean().default(false),
        limit: z.number().int().min(1).max(20).default(10),
        timeout: z.number().int().min(100).max(60000).default(5000),
      }),
      execute: async ({
        by,
        value,
        name,
        exact,
        includeHidden,
        limit,
        timeout,
      }) => {
        try {
          const tabId = activeBrowserTabId(ctx);
          const res = await invoke<string>("browser_automation_handle_action", {
            requestJson: JSON.stringify({
              action: "find",
              tabId,
              by,
              value,
              name,
              exact,
              includeHidden,
              limit,
              timeout,
            }),
          });
          return { status: "ok", result: res };
        } catch (error) {
          return { status: "error", error: String(error) };
        }
      },
    }),

    browser_click: tool({
      description:
        "Click an interactive element in the active browser page using a ref from browser_snapshot.",
      inputSchema: z.object({
        ref: z.string().describe("Latest browser_snapshot ref, e.g. g3-e12."),
      }),
      execute: async ({ ref }) => {
        try {
          const tabId = activeBrowserTabId(ctx);
          const res = await invoke<string>("browser_automation_handle_action", {
            requestJson: JSON.stringify({ action: "click", tabId, ref }),
          });
          return { status: "ok", result: res };
        } catch (error) {
          return { status: "error", error: String(error) };
        }
      },
    }),

    browser_double_click: tool({
      description: "Double-click an actionable element using a current ref.",
      inputSchema: z.object({ ref: z.string() }),
      execute: async ({ ref }) => {
        try {
          const tabId = activeBrowserTabId(ctx);
          const res = await invoke<string>("browser_automation_handle_action", {
            requestJson: JSON.stringify({ action: "double_click", tabId, ref }),
          });
          return { status: "ok", result: res };
        } catch (error) {
          return { status: "error", error: String(error) };
        }
      },
    }),

    browser_focus: tool({
      description: "Focus a visible enabled element using a current ref.",
      inputSchema: z.object({ ref: z.string() }),
      execute: async ({ ref }) => {
        try {
          const tabId = activeBrowserTabId(ctx);
          const res = await invoke<string>("browser_automation_handle_action", {
            requestJson: JSON.stringify({ action: "focus", tabId, ref }),
          });
          return { status: "ok", result: res };
        } catch (error) {
          return { status: "error", error: String(error) };
        }
      },
    }),

    browser_check: tool({
      description: "Check or uncheck a checkbox or radio and verify its state.",
      inputSchema: z.object({
        ref: z.string(),
        checked: z.boolean().default(true),
      }),
      execute: async ({ ref, checked }) => {
        try {
          const tabId = activeBrowserTabId(ctx);
          const res = await invoke<string>("browser_automation_handle_action", {
            requestJson: JSON.stringify({
              action: "check",
              tabId,
              ref,
              checked,
            }),
          });
          return { status: "ok", result: res };
        } catch (error) {
          return { status: "error", error: String(error) };
        }
      },
    }),

    browser_drag: tool({
      description:
        "Drag one current ref onto another in the same document or frame.",
      inputSchema: z.object({
        sourceRef: z.string(),
        targetRef: z.string(),
      }),
      execute: async ({ sourceRef, targetRef }) => {
        try {
          const tabId = activeBrowserTabId(ctx);
          const res = await invoke<string>("browser_automation_handle_action", {
            requestJson: JSON.stringify({
              action: "drag",
              tabId,
              sourceRef,
              targetRef,
            }),
          });
          return { status: "ok", result: res };
        } catch (error) {
          return { status: "error", error: String(error) };
        }
      },
    }),

    browser_type: tool({
      description:
        "Type text into an input field or textarea using a ref from browser_snapshot.",
      inputSchema: z.object({
        ref: z.string().describe("Latest browser_snapshot ref, e.g. g3-e12."),
        text: z.string().describe("Text content to type into the field."),
        append: z
          .boolean()
          .default(false)
          .describe("Append instead of replacing existing text."),
      }),
      execute: async ({ ref, text, append }) => {
        try {
          const tabId = activeBrowserTabId(ctx);
          const res = await invoke<string>("browser_automation_handle_action", {
            requestJson: JSON.stringify({
              action: "type",
              tabId,
              ref,
              text,
              append,
            }),
          });
          return { status: "ok", result: res };
        } catch (error) {
          return { status: "error", error: String(error) };
        }
      },
    }),

    browser_scroll: tool({
      description: "Scroll the active browser page by offset (x, y).",
      inputSchema: z.object({
        x: z
          .number()
          .default(0)
          .describe("Horizontal scroll offset in pixels."),
        y: z
          .number()
          .default(300)
          .describe("Vertical scroll offset in pixels."),
      }),
      execute: async ({ x, y }) => {
        try {
          const tabId = activeBrowserTabId(ctx);
          const res = await invoke<string>("browser_automation_handle_action", {
            requestJson: JSON.stringify({ action: "scroll", tabId, x, y }),
          });
          return { status: "ok", result: res };
        } catch (error) {
          return { status: "error", error: String(error) };
        }
      },
    }),

    browser_press_key: tool({
      description:
        "Press a keyboard key on the active browser page. Enter observation runs without blocking stop, navigation, or other tab actions.",
      inputSchema: z.object({
        key: z
          .string()
          .describe(
            "The key name to simulate, e.g. 'Enter', 'Escape', 'ArrowDown', 'Tab', 'Space'.",
          ),
        observationTimeout: z
          .number()
          .int()
          .min(0)
          .max(10_000)
          .default(3_000)
          .describe(
            "Milliseconds to observe submit or navigation after Enter. Ignored for other keys.",
          ),
      }),
      execute: async ({ key, observationTimeout }) => {
        try {
          const tabId = activeBrowserTabId(ctx);
          const res = await invoke<string>("browser_automation_handle_action", {
            requestJson: JSON.stringify({
              action: "press_key",
              tabId,
              key,
              observationTimeout,
            }),
          });
          return { status: "ok", result: res };
        } catch (error) {
          return { status: "error", error: String(error) };
        }
      },
    }),

    browser_keyboard: tool({
      description:
        "Dispatch a keyboard press, key-down, or key-up with optional modifiers.",
      inputSchema: z.object({
        key: z.string(),
        keyAction: z.enum(["press", "down", "up"]).default("press"),
        modifiers: z
          .array(z.enum(["Alt", "Control", "Meta", "Shift"]))
          .max(4)
          .default([]),
      }),
      execute: async ({ key, keyAction, modifiers }) => {
        try {
          const tabId = activeBrowserTabId(ctx);
          const res = await invoke<string>("browser_automation_handle_action", {
            requestJson: JSON.stringify({
              action: "key",
              tabId,
              key,
              keyAction,
              modifiers,
            }),
          });
          return { status: "ok", result: res };
        } catch (error) {
          return { status: "error", error: String(error) };
        }
      },
    }),

    browser_wait: tool({
      description:
        "Wait for text, URL, document load state, or an element ref state.",
      inputSchema: z.object({
        condition: z.enum(["text", "url", "load", "ref"]).optional(),
        text: z.string().optional(),
        url: z.string().optional(),
        ref: z.string().optional(),
        state: z
          .enum([
            "attached",
            "detached",
            "visible",
            "hidden",
            "enabled",
            "disabled",
            "checked",
            "unchecked",
          ])
          .optional(),
        loadState: z
          .enum(["interactive", "complete", "networkIdle"])
          .optional(),
        timeout: z
          .number()
          .default(10000)
          .describe("Timeout in milliseconds (default: 10000)."),
      }),
      execute: async ({
        condition,
        text,
        url,
        ref,
        state,
        loadState,
        timeout,
      }) => {
        try {
          const tabId = activeBrowserTabId(ctx);
          const res = await invoke<string>("browser_automation_handle_action", {
            requestJson: JSON.stringify({
              action: "wait",
              tabId,
              condition,
              text,
              url,
              ref,
              state,
              loadState,
              timeout,
            }),
          });
          return { status: "ok", result: res };
        } catch (error) {
          return { status: "error", error: String(error) };
        }
      },
    }),

    browser_dialog: tool({
      description:
        "Click a current ref that opens an alert, confirm, or prompt, then accept or dismiss it without leaving a blocking dialog open.",
      inputSchema: z.object({
        ref: z.string(),
        dialogAction: z.enum(["accept", "dismiss"]),
        promptText: z.string().optional(),
      }),
      execute: async ({ ref, dialogAction, promptText }) => {
        try {
          const tabId = activeBrowserTabId(ctx);
          const res = await invoke<string>("browser_automation_handle_action", {
            requestJson: JSON.stringify({
              action: "dialog",
              tabId,
              ref,
              dialogAction,
              promptText,
            }),
          });
          return { status: "ok", result: res };
        } catch (error) {
          return { status: "error", error: String(error) };
        }
      },
    }),

    browser_screenshot: tool({
      description:
        "Take a screenshot of the active browser page and save it to the artifacts directory.",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const tabId = activeBrowserTabId(ctx);
          const workspace = ctx.getWorkspaceRoot() ?? ctx.getCwd();
          const res = await invoke<string>("browser_automation_handle_action", {
            requestJson: JSON.stringify({
              action: "screenshot",
              tabId,
              workspace,
            }),
          });
          return { status: "ok", result: res };
        } catch (error) {
          return { status: "error", error: String(error) };
        }
      },
    }),

    browser_console_logs: tool({
      description:
        "Retrieve bounded console messages, uncaught runtime errors, and unhandled promise rejections from the active browser page and accessible frames.",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const tabId = activeBrowserTabId(ctx);
          const res = await invoke<string>("browser_automation_handle_action", {
            requestJson: JSON.stringify({ action: "console_logs", tabId }),
          });
          return { status: "ok", result: res };
        } catch (error) {
          return { status: "error", error: String(error) };
        }
      },
    }),

    browser_history: tool({
      description:
        "Control page history or reload on the active browser page (reload, back, forward, stop).",
      inputSchema: z.object({
        action: z
          .enum(["reload", "back", "forward", "stop"])
          .describe("History or reload action to execute."),
      }),
      execute: async ({ action }) => {
        try {
          const tabId = activeBrowserTabId(ctx);
          const res = await invoke<string>("browser_automation_handle_action", {
            requestJson: JSON.stringify({ action, tabId }),
          });
          return { status: "ok", result: res };
        } catch (error) {
          return { status: "error", error: String(error) };
        }
      },
    }),

    browser_select_option: tool({
      description:
        "Select an option in a <select> dropdown by ref. `value` may be the option's value attribute OR its visible label text.",
      inputSchema: z.object({
        ref: z
          .string()
          .describe(
            "Latest browser_snapshot ref for the <select>, e.g. g3-e12.",
          ),
        value: z
          .string()
          .describe(
            "Option value (value attribute) or its visible label text.",
          ),
      }),
      execute: async ({ ref, value }) => {
        try {
          const tabId = activeBrowserTabId(ctx);
          const res = await invoke<string>("browser_automation_handle_action", {
            requestJson: JSON.stringify({
              action: "select_option",
              tabId,
              ref,
              value,
            }),
          });
          return { status: "ok", result: res };
        } catch (error) {
          return { status: "error", error: String(error) };
        }
      },
    }),

    browser_hover: tool({
      description:
        "Hover over an actionable element by ref using real pointer movement, with CSS pseudo-state verification for main-document targets.",
      inputSchema: z.object({
        ref: z.string().describe("Latest browser_snapshot ref, e.g. g3-e12."),
      }),
      execute: async ({ ref }) => {
        try {
          const tabId = activeBrowserTabId(ctx);
          const res = await invoke<string>("browser_automation_handle_action", {
            requestJson: JSON.stringify({ action: "hover", tabId, ref }),
          });
          return { status: "ok", result: res };
        } catch (error) {
          return { status: "error", error: String(error) };
        }
      },
    }),

    browser_scroll_to_element: tool({
      description:
        "Scroll a specific element into the visible viewport by ref.",
      inputSchema: z.object({
        ref: z.string().describe("Latest browser_snapshot ref, e.g. g3-e12."),
      }),
      execute: async ({ ref }) => {
        try {
          const tabId = activeBrowserTabId(ctx);
          const res = await invoke<string>("browser_automation_handle_action", {
            requestJson: JSON.stringify({
              action: "scroll_to_element",
              tabId,
              ref,
            }),
          });
          return { status: "ok", result: res };
        } catch (error) {
          return { status: "error", error: String(error) };
        }
      },
    }),

    browser_get_text: tool({
      description:
        "Read text content of the active browser page, or of a specific element by ref. Returns up to maxLength characters.",
      inputSchema: z.object({
        ref: z
          .string()
          .optional()
          .describe(
            "Element ref from browser_snapshot to read a specific element. Omit to read the whole page.",
          ),
        maxLength: z
          .number()
          .default(8000)
          .describe("Maximum characters to return (default: 8000)."),
      }),
      execute: async ({ ref, maxLength }) => {
        try {
          const tabId = activeBrowserTabId(ctx);
          const res = await invoke<string>("browser_automation_handle_action", {
            requestJson: JSON.stringify({
              action: "get_text",
              tabId,
              ref,
              maxLength: maxLength ?? 8000,
            }),
          });
          return { status: "ok", result: res };
        } catch (error) {
          return { status: "error", error: String(error) };
        }
      },
    }),

    browser_get_page_info: tool({
      description: "Get the title and URL of the active browser page.",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const tabId = activeBrowserTabId(ctx);
          const res = await invoke<string>("browser_automation_handle_action", {
            requestJson: JSON.stringify({ action: "get_page_info", tabId }),
          });
          return { status: "ok", result: res };
        } catch (error) {
          return { status: "error", error: String(error) };
        }
      },
    }),

    browser_list_tabs: tool({
      description:
        "List all open browser tabs with their URL and title, and which tab id is currently active.",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const res = await invoke<string>("browser_automation_handle_action", {
            requestJson: JSON.stringify({ action: "list_tabs" }),
          });
          const parsed = JSON.parse(res) as { tabs?: unknown[] };
          return {
            status: "ok",
            tabs: parsed.tabs ?? [],
            activeTabId: ctx.getActiveBrowserTabId(),
          };
        } catch (error) {
          return { status: "error", error: String(error) };
        }
      },
    }),

    browser_new_tab: tool({
      description:
        "Open a new browser tab and navigate it to an HTTP or HTTPS URL. The new tab becomes the active tab.",
      inputSchema: z.object({
        url: z.string().describe("The HTTP or HTTPS URL to open."),
      }),
      execute: async ({ url }) => {
        try {
          const protocol = new URL(url).protocol;
          if (protocol !== "http:" && protocol !== "https:") {
            return { status: "error", error: "only HTTP(S) URLs are allowed" };
          }
          const opened = ctx.openBrowser(url);
          return opened
            ? { status: "ok", opened: true, url }
            : { status: "error", error: "could not open browser tab" };
        } catch (error) {
          return { status: "error", error: String(error) };
        }
      },
    }),

    browser_switch_tab: tool({
      description:
        "Switch the active browser tab to the one with the given id (from browser_list_tabs). Subsequent browser actions target this tab.",
      inputSchema: z.object({
        tabId: z.number().describe("Browser tab id from browser_list_tabs."),
      }),
      execute: async ({ tabId }) => {
        const ok = ctx.switchBrowserTab(tabId);
        return ok
          ? { status: "ok", activeTabId: tabId }
          : { status: "error", error: `no browser tab with id ${tabId}` };
      },
    }),

    browser_close_tab: tool({
      description:
        "Close the browser tab with the given id (from browser_list_tabs).",
      needsApproval: true,
      inputSchema: z.object({
        tabId: z.number().describe("Browser tab id from browser_list_tabs."),
      }),
      execute: async ({ tabId }) => {
        const ok = ctx.closeBrowserTab(tabId);
        return ok
          ? { status: "ok", closed: true, tabId }
          : { status: "error", error: `no tab with id ${tabId}` };
      },
    }),
  };
}
