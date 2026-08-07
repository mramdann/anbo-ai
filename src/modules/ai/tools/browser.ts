import { tool } from "ai";
import { z } from "zod";
import type { ToolContext } from "./context";
import { invoke } from "@tauri-apps/api/core";

export function buildBrowserTools(_ctx: ToolContext) {
  return {
    browser_navigate: tool({
      description:
        "Navigate the active browser preview page to a target URL (e.g. http://localhost:3000).",
      inputSchema: z.object({
        url: z.string().describe("The HTTP or HTTPS URL to navigate to."),
      }),
      execute: async ({ url }) => {
        try {
          const res = await invoke<string>("browser_automation_handle_action", {
            requestJson: JSON.stringify({ action: "navigate", url }),
          });
          return { status: "ok", result: res };
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
          const res = await invoke<string>("browser_automation_handle_action", {
            requestJson: JSON.stringify({ action: "snapshot" }),
          });
          return { status: "ok", snapshot: res };
        } catch (error) {
          return { status: "error", error: String(error) };
        }
      },
    }),

    browser_click: tool({
      description:
        "Click an interactive element in the active web preview page using a CSS selector or element ID.",
      inputSchema: z.object({
        selector: z
          .string()
          .describe("CSS selector or element ID (e.g. '#submit-btn' or 'button.save')."),
      }),
      execute: async ({ selector }) => {
        try {
          const res = await invoke<string>("browser_automation_handle_action", {
            requestJson: JSON.stringify({ action: "click", selector }),
          });
          return { status: "ok", result: res };
        } catch (error) {
          return { status: "error", error: String(error) };
        }
      },
    }),

    browser_type: tool({
      description:
        "Type text into an input field or textarea in the active web preview page.",
      inputSchema: z.object({
        selector: z
          .string()
          .describe("CSS selector for target input field."),
        text: z.string().describe("Text content to type into the field."),
      }),
      execute: async ({ selector, text }) => {
        try {
          const res = await invoke<string>("browser_automation_handle_action", {
            requestJson: JSON.stringify({ action: "type", selector, text }),
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
          const res = await invoke<string>("browser_automation_handle_action", {
            requestJson: JSON.stringify({ action: "scroll", x, y }),
          });
          return { status: "ok", result: res };
        } catch (error) {
          return { status: "error", error: String(error) };
        }
      },
    }),
  };
}
