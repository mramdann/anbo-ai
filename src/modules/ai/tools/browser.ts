import { invoke } from "@tauri-apps/api/core";
import { tool } from "ai";
import { z } from "zod";
import type { ToolContext } from "./context";

const targetLocator = z
  .object({
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
    value: z.string().min(1).max(4096),
    name: z.string().min(1).max(4096).optional(),
    exact: z.boolean().optional(),
    includeHidden: z.boolean().optional(),
    timeout: z.number().int().min(100).max(60000).optional(),
  })
  .strict()
  .describe(
    "Unique target alternative to ref. Bounded lookup; ambiguous or incomplete scans never dispatch input. timeout bounds lookup only.",
  );

function withLocator<T extends z.ZodRawShape>(
  schema: z.ZodObject<T>,
  optional = false,
) {
  return schema
    .extend({
      ref: z.string().min(1).max(32).optional(),
      locator: targetLocator.optional(),
    })
    .refine((value) => {
      const target = value as { ref?: string; locator?: unknown };
      return (
        !(target.ref && target.locator) &&
        (optional || Boolean(target.ref || target.locator))
      );
    }, "Use one ref or locator");
}

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
    titleSource: z
      .enum(["document", "native"])
      .optional()
      .describe(
        "Use the source returned by page info or snapshot; default document. Requires title.",
      ),
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
    (value) =>
      Boolean(value.url || value.title || value.text) &&
      (!value.titleSource || Boolean(value.title)),
    "Provide url, title, or text; titleSource requires title",
  );

function activeBrowserTabId(ctx: ToolContext): number {
  const tabId = ctx.getActiveBrowserTabId();
  if (tabId === null) throw new Error("no active browser tab");
  return tabId;
}

export function buildBrowserTools(ctx: ToolContext) {
  const runAction = async (
    action: string,
    params: Record<string, unknown> = {},
    key = "result",
  ) => {
    try {
      const tabId =
        typeof params.tabId === "number"
          ? params.tabId
          : activeBrowserTabId(ctx);
      const result = await invoke<string>("browser_automation_handle_action", {
        requestJson: JSON.stringify({ action, tabId, ...params }),
      });
      return { status: "ok", [key]: result };
    } catch (error) {
      return { status: "error", error: String(error) };
    }
  };
  return {
    browser_end_session: tool({
      description:
        "End visual control on completion, failure, or handoff: once per used tab with its controlId, not between steps. Leaves tabs and terminals open.",
      inputSchema: z.object({
        tabId: z.number().int().positive(),
        controlId: z.number().int().positive(),
      }),
      execute: (params) => runAction("end_session", params),
    }),
    browser_navigate: tool({
      description:
        "Navigate to an HTTP(S) URL, including external sites. Opens a tab if no browser is active.",
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
        "Bounded DOM snapshot with fresh refs, replacing this tab's prior snapshot/find refs. Prefer targeted find for known elements.",
      inputSchema: z.object({}),
      execute: () => runAction("snapshot", {}, "snapshot"),
    }),

    browser_find: tool({
      description:
        "Find elements and replace this tab's prior snapshot/find refs. Prefer role, label, placeholder, or testId over CSS.",
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
            "Computed role name; ARIA, labels, alt, or title may override visible text.",
          ),
        exact: z.boolean().default(false),
        includeHidden: z.boolean().default(false),
        limit: z.number().int().min(1).max(20).default(10),
        timeout: z.number().int().min(100).max(60000).default(5000),
      }),
      execute: ({ by, value, name, exact, includeHidden, limit, timeout }) =>
        runAction("find", {
          by,
          value,
          name,
          exact,
          includeHidden,
          limit,
          timeout,
        }),
    }),

    browser_click: tool({
      description:
        "Click a current ref. waitFor verifies SPA state; navigation/stop remain available. Timeout does not undo input: inspect before retrying.",
      inputSchema: withLocator(
        z.object({
          waitFor: pageExpectation.optional(),
          diagnostics: z.boolean().optional(),
        }),
      ),
      execute: (params) => runAction("click", params),
    }),

    browser_double_click: tool({
      description: "Double-click an actionable element using a current ref.",
      inputSchema: withLocator(z.object({})),
      execute: (params) => runAction("double_click", params),
    }),

    browser_focus: tool({
      description: "Focus a visible enabled element using a current ref.",
      inputSchema: withLocator(z.object({})),
      execute: (params) => runAction("focus", params),
    }),

    browser_check: tool({
      description: "Check or uncheck a checkbox or radio and verify its state.",
      inputSchema: withLocator(
        z.object({
          checked: z.boolean().default(true),
        }),
      ),
      execute: (params) => runAction("check", params),
    }),

    browser_drag: tool({
      description:
        "Drag between current refs in one document/frame. Both endpoints must be visible after scrolling; geometry is rechecked before press. No automatic input retries.",
      inputSchema: z.object({
        sourceRef: z.string(),
        targetRef: z.string(),
      }),
      execute: ({ sourceRef, targetRef }) =>
        runAction("drag", { sourceRef, targetRef }),
    }),

    browser_type: tool({
      description:
        "Type into a current ref and verify its value. Before Enter, pass ref and expectedValue to browser_press_key to detect subsequent resets/replacements.",
      inputSchema: withLocator(
        z.object({
          text: z.string().describe("Text content to type into the field."),
          append: z
            .boolean()
            .default(false)
            .describe("Append instead of replacing existing text."),
        }),
      ),
      execute: (params) => runAction("type", params),
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
      execute: ({ x, y }) => runAction("scroll", { x, y }),
    }),

    browser_press_key: tool({
      description:
        "Press a key. For forms, ref + expectedValue guard against resets/replacements. waitFor checks SPA state instead of Enter's observation window. Inspect before resubmitting after timeout.",
      inputSchema: withLocator(
        z.object({
          key: z
            .string()
            .describe("Key name: Enter, Escape, ArrowDown, Tab, Space, etc."),
          expectedValue: z.string().max(65536).optional(),
          waitFor: pageExpectation.optional(),
          diagnostics: z.boolean().optional(),
          observationTimeout: z
            .number()
            .int()
            .min(0)
            .max(10_000)
            .default(3_000)
            .describe("Enter-only submit/navigation observation in ms."),
        }),
        true,
      ),
      execute: (params) => runAction("press_key", params),
    }),

    browser_keyboard: tool({
      description:
        "Keyboard press/down/up. Supply modifiers per event; they cannot persist across tools or modify mouse clicks.",
      inputSchema: z.object({
        key: z.string(),
        keyAction: z.enum(["press", "down", "up"]).default("press"),
        modifiers: z
          .array(z.enum(["Alt", "Control", "Meta", "Shift"]))
          .max(4)
          .default([]),
      }),
      execute: ({ key, keyAction, modifiers }) =>
        runAction("key", { key, keyAction, modifiers }),
    }),

    browser_wait: tool({
      description:
        "Wait for text, URL, load, or ref state; alternatively use waitFor alone for stable URL/title/visible-text SPA conditions.",
      inputSchema: z.object({
        condition: z.enum(["text", "url", "load", "ref", "locator"]).optional(),
        locator: targetLocator
          .omit({ includeHidden: true, timeout: true })
          .optional()
          .describe(
            "Wait on a unique locator including hidden elements. Use state and top-level timeout, without legacy fields or waitFor.",
          ),
        text: z.string().optional(),
        url: z.string().optional(),
        ref: z.string().optional(),
        state: z
          .enum([
            "attached",
            "absent",
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
            "networkIdle: observed page-target requests complete + 500ms quiet. Excludes WebSockets/other CDP targets; prefer explicit conditions for streaming apps.",
          ),
        timeout: z
          .number()
          .optional()
          .describe("Timeout in milliseconds (default: 10000)."),
        waitFor: pageExpectation.optional(),
        diagnostics: z.boolean().optional(),
      }),
      execute: ({
        condition,
        locator,
        text,
        url,
        ref,
        state,
        loadState,
        timeout,
        waitFor,
        diagnostics,
      }) =>
        runAction("wait", {
          condition,
          locator,
          text,
          url,
          ref,
          state,
          loadState,
          timeout,
          waitFor,
          diagnostics,
        }),
    }),

    browser_dialog: tool({
      description:
        "Click a ref and handle alert/confirm/prompt. Check clickDispatched and dialogOpened: no dialog means ok:false despite dispatched input. Never blindly repeat.",
      inputSchema: withLocator(
        z.object({
          dialogAction: z.enum(["accept", "dismiss"]),
          promptText: z.string().optional(),
        }),
      ),
      execute: (params) => runAction("dialog", params),
    }),

    browser_screenshot: tool({
      description:
        "Save a viewport screenshot artifact, excluding automation cursor effects. Not full-page.",
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
        "Bounded console messages, runtime errors, and unhandled rejections from the active page and accessible frames.",
      inputSchema: z.object({}),
      execute: () => runAction("console_logs"),
    }),

    browser_history: tool({
      description: "Active page history: reload, back, forward, stop.",
      inputSchema: z.object({
        action: z
          .enum(["reload", "back", "forward", "stop"])
          .describe("History or reload action to execute."),
      }),
      execute: ({ action }) => runAction(action),
    }),

    browser_select_option: tool({
      description:
        "Select a <select> option by ref using its value attribute or visible label.",
      inputSchema: withLocator(
        z.object({
          value: z.string().describe("Option value or visible label."),
        }),
      ),
      execute: (params) => runAction("select_option", params),
    }),

    browser_hover: tool({
      description:
        "Hover a ref: one native move with CSS-hover verification; child frames report DOM-only fallback. position moves within a target to reveal media controls. CSS hover alone does not prove controls visible.",
      inputSchema: withLocator(
        z.object({
          position: z
            .object({
              x: z.number().gt(0).lt(1),
              y: z.number().gt(0).lt(1),
            })
            .strict()
            .optional()
            .describe(
              "Painted-fragment fractions 0<x,y<1, not pixels. Default center {x:0.5,y:0.5}; x:0.6 moves right. Point must be visible and unobscured.",
            ),
        }),
      ),
      execute: (params) => runAction("hover", params),
    }),

    browser_scroll_to_element: tool({
      description:
        "Scroll a specific element into the visible viewport by ref.",
      inputSchema: withLocator(z.object({})),
      execute: (params) => runAction("scroll_to_element", params),
    }),

    browser_get_text: tool({
      description:
        "Read bounded page/element text with visible and source metadata. Hidden accessibleName may be stale: reveal and reread before trusting it as live state.",
      inputSchema: withLocator(
        z.object({
          maxLength: z
            .number()
            .default(8000)
            .describe("Maximum characters to return (default: 8000)."),
        }),
        true,
      ),
      execute: ({ ref, locator, maxLength }) =>
        runAction("get_text", { ref, locator, maxLength: maxLength ?? 8000 }),
    }),

    browser_get_page_info: tool({
      description:
        "Get native URL/title without waiting for scripts, or request document title. Reuse returned titleSource in waitFor after SPA history navigation.",
      inputSchema: z.object({
        titleSource: z.enum(["native", "document"]).optional(),
      }),
      execute: ({ titleSource }) => runAction("get_page_info", { titleSource }),
    }),

    browser_list_tabs: tool({
      description: "List browser tabs, URLs, titles, and active tab ID.",
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
      description: "Open and activate a new HTTP(S) browser tab.",
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
        "Activate a browser_list_tabs ID as the target for subsequent actions.",
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
      description: "Close a browser_list_tabs ID.",
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
