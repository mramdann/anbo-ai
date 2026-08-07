import { invoke } from "@tauri-apps/api/core";
import { tool } from "ai";
import { z } from "zod";
import type { ToolContext } from "./context";

function activePreviewTabId(ctx: ToolContext): number {
  const tabId = ctx.getActivePreviewTabId();
  if (tabId === null) throw new Error("no active browser preview tab");
  return tabId;
}

export function buildBrowserTools(ctx: ToolContext) {
  return {
    browser_navigate: tool({
      description:
        "Open or navigate the native browser preview to any HTTP or HTTPS URL, including external sites. Opens a new preview when none is active.",
      inputSchema: z.object({
        url: z.string().describe("The HTTP or HTTPS URL to navigate to."),
      }),
      execute: async ({ url }) => {
        try {
          const protocol = new URL(url).protocol;
          if (protocol !== "http:" && protocol !== "https:") {
            return { status: "error", error: "only HTTP(S) URLs are allowed" };
          }
          const opened = ctx.navigatePreview(url);
          return opened
            ? { status: "ok", opened: true, url }
            : { status: "error", error: "browser preview unavailable" };
        } catch (error) {
          return { status: "error", error: String(error) };
        }
      },
    }),

    browser_snapshot: tool({
      description:
        "Capture a token-lean DOM snapshot and interactive element list of the active web preview page.",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const tabId = activePreviewTabId(ctx);
          const res = await invoke<string>("browser_automation_handle_action", {
            requestJson: JSON.stringify({ action: "snapshot", tabId }),
          });
          return { status: "ok", snapshot: res };
        } catch (error) {
          return { status: "error", error: String(error) };
        }
      },
    }),

    browser_click: tool({
      description:
        "Click an interactive element in the active web preview page using a ref from browser_snapshot.",
      inputSchema: z.object({
        ref: z.string().describe("Element ref from browser_snapshot, e.g. e12."),
      }),
      execute: async ({ ref }) => {
        try {
          const tabId = activePreviewTabId(ctx);
          const res = await invoke<string>("browser_automation_handle_action", {
            requestJson: JSON.stringify({ action: "click", tabId, ref }),
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
        ref: z.string().describe("Element ref from browser_snapshot, e.g. e12."),
        text: z.string().describe("Text content to type into the field."),
        append: z.boolean().default(false).describe("Append instead of replacing existing text."),
      }),
      execute: async ({ ref, text, append }) => {
        try {
          const tabId = activePreviewTabId(ctx);
          const res = await invoke<string>("browser_automation_handle_action", {
            requestJson: JSON.stringify({ action: "type", tabId, ref, text, append }),
          });
          return { status: "ok", result: res };
        } catch (error) {
          return { status: "error", error: String(error) };
        }
      },
    }),

    browser_scroll: tool({
      description: "Scroll the active web preview page by offset (x, y).",
      inputSchema: z.object({
        x: z.number().default(0).describe("Horizontal scroll offset in pixels."),
        y: z.number().default(300).describe("Vertical scroll offset in pixels."),
      }),
      execute: async ({ x, y }) => {
        try {
          const tabId = activePreviewTabId(ctx);
          const res = await invoke<string>("browser_automation_handle_action", {
            requestJson: JSON.stringify({ action: "scroll", tabId, x, y }),
          });
          return { status: "ok", result: res };
        } catch (error) {
          return { status: "error", error: String(error) };
        }
      },
    }),
  };
}
