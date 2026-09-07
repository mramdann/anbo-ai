import { invoke } from "@tauri-apps/api/core";
import { tool } from "ai";
import { z } from "zod";
import type { ToolContext } from "./context";

const pageExpectation = z
  .object({
    url: z
      .string()
      .min(1)
      .max(8192)
      .optional()
      .describe("Exact URL or glob with * wildcards."),
    title: z
      .string()
      .min(1)
      .max(2048)
      .optional()
      .describe("Exact title after whitespace normalization."),
    text: z
      .string()
      .min(1)
      .max(2048)
      .optional()
      .describe("Substring in bounded visible main-document text."),
    timeout: z.number().int().min(100).max(60000).optional(),
    stableFor: z
      .number()
      .int()
      .min(0)
      .max(2000)
      .optional()
      .describe(
        "Observed match window in milliseconds, default 200; sampled every 100ms; cannot exceed timeout.",
      ),
  })
  .strict()
  .refine(
    (value) => Boolean(value.url || value.title || value.text),
    "Provide url, title, or text",
  );

function activeBrowserTabId(ctx: ToolContext): number {
  const tabId = ctx.getActiveBrowserTabId();
  if (tabId === null) throw new Error("no active browser tab");
  return tabId;
}

export function buildBrowserTools(ctx: ToolContext) {
  return {
    browser_end_session: tool({
      description:
        "End the visual remote session when the browser task finishes, fails, or is handed back to the user. Call for each used tab with its returned controlId. Do not call between steps. Does not close a tab or terminal.",
      inputSchema: z.object({
        tabId: z.number().int().positive(),
        controlId: z.number().int().positive(),
      }),
      execute: async ({ tabId, controlId }) => {
        try {
          const result = await invoke<string>(
            "browser_automation_handle_action",
            {
              requestJson: JSON.stringify({
                action: "end_session",
                tabId,
                controlId,
              }),
            },
          );
          return { status: "ok", result };
        } catch (error) {
          return { status: "error", error: String(error) };
        }
      },
    }),
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
        "Capture a bounded DOM snapshot with current element refs. Both snapshot and find replace older refs for this tab. Prefer a targeted find when the element is already known.",
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
        "Find elements with a semantic locator and return fresh refs, replacing older snapshot and find refs for this tab. Prefer role, label, placeholder, or testId over CSS.",
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
        "Click a current element ref. Optional waitFor verifies the resulting SPA state without blocking navigation or stop. A postcondition timeout does not undo the click; inspect before retrying.",
      inputSchema: z.object({
        ref: z.string().describe("Latest snapshot or find ref, e.g. g3-e12."),
        waitFor: pageExpectation.optional(),
        diagnostics: z.boolean().optional(),
      }),
      execute: async ({ ref, waitFor, diagnostics }) => {
        try {
          const tabId = activeBrowserTabId(ctx);
          const res = await invoke<string>("browser_automation_handle_action", {
            requestJson: JSON.stringify({
              action: "click",
              tabId,
              ref,
              waitFor,
              diagnostics,
            }),
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
        "Drag one current ref onto another in the same document or frame. Native mouse drag requires both endpoints visible together after scrolling and rechecks geometry before press. No automatic input retries.",
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
        "Type into a current input ref and verify its immediate value. Before Enter, pass this ref and expectedValue to browser_press_key to detect a later SPA reset or node replacement.",
      inputSchema: z.object({
        ref: z.string().describe("Latest snapshot or find ref, e.g. g3-e12."),
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
        "Press a keyboard key. For forms, pass the input ref and expectedValue to prevent submission after a reset or replacement. waitFor verifies the resulting SPA state and replaces Enter's default observation window. Inspect the page before resubmitting after a postcondition timeout.",
      inputSchema: z.object({
        key: z
          .string()
          .describe(
            "The key name to simulate, e.g. 'Enter', 'Escape', 'ArrowDown', 'Tab', 'Space'.",
          ),
        ref: z.string().optional(),
        expectedValue: z.string().max(65536).optional(),
        waitFor: pageExpectation.optional(),
        diagnostics: z.boolean().optional(),
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
      execute: async ({
        key,
        observationTimeout,
        ref,
        expectedValue,
        waitFor,
        diagnostics,
      }) => {
        try {
          const tabId = activeBrowserTabId(ctx);
          const res = await invoke<string>("browser_automation_handle_action", {
            requestJson: JSON.stringify({
              action: "press_key",
              tabId,
              key,
              observationTimeout,
              ref,
              expectedValue,
              waitFor,
              diagnostics,
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
        "Dispatch a keyboard press, key-down, or key-up. Modifiers are per-call: pass the combination on each event. Holding modifiers across tools or applying them to mouse clicks is not supported.",
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
        "Wait for text, URL, load, or a ref. Alternatively use waitFor alone to require a stable combination of URL, title, and visible text for an SPA result.",
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
          .optional()
          .describe(
            "networkIdle waits for observed native page-target requests to finish plus 500ms of quiet. It excludes WebSocket traffic and separate CDP targets; prefer explicit postconditions for streaming apps.",
          ),
        timeout: z
          .number()
          .optional()
          .describe("Timeout in milliseconds (default: 10000)."),
        waitFor: pageExpectation.optional(),
        diagnostics: z.boolean().optional(),
      }),
      execute: async ({
        condition,
        text,
        url,
        ref,
        state,
        loadState,
        timeout,
        waitFor,
        diagnostics,
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
              waitFor,
              diagnostics,
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
        "Click a current ref and handle its alert, confirm, or prompt. Inspect clickDispatched and dialogOpened separately: ok is false if no dialog opened, but the click already happened. Do not blindly repeat it.",
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
        "Capture the browser viewport, not the full page, and save a screenshot artifact. Automation cursor effects are excluded.",
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
            "Latest snapshot or find ref for the <select>, e.g. g3-e12.",
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
        "Hover over an actionable element by ref. Main-document targets use one native pointer movement and verify CSS hover without replaying DOM events. Child-frame targets report a DOM-only fallback.",
      inputSchema: z.object({
        ref: z.string().describe("Latest snapshot or find ref, e.g. g3-e12."),
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
        ref: z.string().describe("Latest snapshot or find ref, e.g. g3-e12."),
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
        "Read page or element text, bounded by maxLength. The result includes visible and source. A hidden element's accessibleName can be outdated; reveal the control and read it again before treating it as live state.",
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
