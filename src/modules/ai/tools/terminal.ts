import { tool } from "ai";
import { z } from "zod";
import { checkShellCommand } from "../lib/security";
import type { ToolContext } from "./context";

export function buildTerminalTools(ctx: ToolContext) {
  const sharedTerminalRequest = (
    method: Parameters<NonNullable<ToolContext["sharedTerminalRequest"]>>[0],
    params: Record<string, unknown>,
  ) =>
    ctx.sharedTerminalRequest?.(method, params) ??
    Promise.resolve({
      error: {
        code: "terminal_unavailable",
        message: "shared terminal service is not ready",
      },
    });

  return {
    terminal_open: tool({
      description:
        "Open a shared terminal in this run's workspace with a purpose-specific title. Selects the first tab only in an empty active workspace. Wait for idle, then terminal_execute using terminalId.",
      inputSchema: z.object({
        title: z.string().trim().min(1).max(64),
      }),
      needsApproval: true,
      execute: async ({ title }) =>
        sharedTerminalRequest("terminal_open", { title }),
    }),

    terminal_close: tool({
      description:
        "Close an idle terminal_open terminal from this app session. Refuses user/agent terminals, pending input, and foreground jobs.",
      inputSchema: z.object({ terminalId: z.string().min(1) }),
      needsApproval: true,
      execute: async ({ terminalId }) =>
        sharedTerminalRequest("terminal_close", { terminalId }),
    }),

    terminal_list: tool({
      description:
        "Discover shared terminals: IDs, cwd, shell/grid, selection and status. Excludes private/agent tabs. Call before other terminal tools.",
      inputSchema: z.object({}),
      execute: async () => sharedTerminalRequest("terminal_list", {}),
    }),

    terminal_read: tool({
      description:
        "Read bounded, redacted shared-terminal output without focus changes. Reuse cursor. hasMore means unread output; historyTruncated means omitted history; reset/replayed means repaint.",
      inputSchema: z.object({
        terminalId: z.string().min(1),
        cursor: z.string().optional(),
        maxChars: z.number().int().min(1).max(12_000).optional(),
      }),
      execute: async ({ terminalId, cursor, maxChars }) =>
        sharedTerminalRequest("terminal_read", {
          terminalId,
          cursor,
          maxChars,
        }),
    }),

    terminal_wait: tool({
      description:
        "Wait for terminal_execute: stable per-execution phase, completionReason, interrupted, exitCode and bounded redacted output. Completed results are idempotent; timeout is normal.",
      inputSchema: z.object({
        terminalId: z.string().min(1),
        executionId: z.string().min(1).max(128),
        timeout: z.number().int().min(100).max(60_000).optional(),
        maxChars: z.number().int().min(1).max(12_000).optional(),
      }),
      execute: async ({ terminalId, executionId, timeout, maxChars }) =>
        sharedTerminalRequest("terminal_wait", {
          terminalId,
          executionId,
          timeout,
          maxChars,
        }),
    }),

    terminal_interrupt: tool({
      description:
        "Cancel an executionId (queued/dispatched/running), or omit it for Ctrl+C/clearing pending input. Requires approval; preserves workspace focus.",
      inputSchema: z.object({
        terminalId: z.string().min(1),
        executionId: z.string().min(1).max(128).optional(),
      }),
      needsApproval: true,
      execute: async ({ terminalId, executionId }) =>
        sharedTerminalRequest("terminal_interrupt", {
          terminalId,
          executionId,
        }),
    }),

    terminal_insert: tool({
      description:
        "Insert one line into an idle shared terminal without Enter or focus changes. Requires approval; checks echo and returns inputVisible/cursor for terminal_read.",
      inputSchema: z.object({
        terminalId: z.string().min(1),
        text: z.string().min(1).max(8_000),
      }),
      needsApproval: true,
      execute: async ({ terminalId, text }) =>
        sharedTerminalRequest("terminal_insert", { terminalId, text }),
    }),

    terminal_execute: tool({
      description:
        "Queue one cancellable shell-command line in an idle shared terminal. Returns queued executionId; terminal_wait gives its final result. Refuses pending prompt input.",
      inputSchema: z.object({
        terminalId: z.string().min(1),
        text: z.string().min(1).max(8_000),
      }),
      needsApproval: true,
      execute: async ({ terminalId, text }) => {
        const safety = checkShellCommand(text);
        if (!safety.ok) return { error: safety.reason };
        return sharedTerminalRequest("terminal_execute", {
          terminalId,
          text,
        });
      },
    }),

    suggest_command: tool({
      description:
        "Suggest one command as a chat card. Only the user's Insert click writes it to the prompt, without executing. Never inserts automatically.",
      inputSchema: z.object({
        command: z
          .string()
          .describe("The shell command. Single line, no trailing newline."),
        explanation: z
          .string()
          .optional()
          .describe("Optional one-line note shown beside the command."),
      }),
      execute: async ({ command, explanation }) => {
        const safety = checkShellCommand(command);
        if (!safety.ok) return { error: safety.reason };
        // Reject control bytes — the user inserts via click, but the rendered
        // command must reflect exactly what will land at the prompt.
        if (/[\n\r\x00\x1b\x07]/.test(command)) {
          return {
            error: "command must be a single line without control bytes",
          };
        }
        return { command, explanation };
      },
    }),

    get_terminal_output: tool({
      description:
        "Read active-terminal scrollback (80 lines by default; increase only as needed). Empty when absent; Privacy mode refuses access.",
      inputSchema: z.object({
        lines: z
          .number()
          .int()
          .min(1)
          .max(2000)
          .optional()
          .describe("Number of trailing lines to return. Default 80."),
      }),
      execute: async ({ lines }) => {
        if (ctx.isActiveTerminalPrivate()) {
          return {
            error:
              "active terminal is in Privacy mode; its buffer is withheld. Ask the user to switch to a regular tab if they want you to see it.",
          };
        }
        const buffer = ctx.getTerminalContext();
        if (!buffer) return { output: "", note: "no active terminal" };
        const n = lines ?? 80;
        const parts = buffer.split("\n");
        const sliced =
          parts.length <= n ? buffer : parts.slice(parts.length - n).join("\n");
        const MAX = 24_000;
        const capped =
          sliced.length > MAX
            ? `…[truncated]…\n${sliced.slice(sliced.length - MAX)}`
            : sliced;
        return { output: capped, lines_returned: Math.min(parts.length, n) };
      },
    }),

    open_browser: tool({
      description:
        "Open a local dev-server preview. This helper only accepts HTTP(S) loopback URLs; use browser_navigate or browser_new_tab for external sites.",
      inputSchema: z.object({
        url: z
          .url()
          .describe("HTTP(S) loopback URL, e.g. http://localhost:5173."),
      }),
      execute: async ({ url }) => {
        let parsed: URL;
        try {
          parsed = new URL(url);
        } catch {
          return { error: "invalid URL", url };
        }
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          return { error: "only http/https URLs are allowed", url };
        }
        const host = parsed.hostname;
        const isLocal =
          host === "localhost" ||
          host === "127.0.0.1" ||
          host === "0.0.0.0" ||
          host === "[::1]" ||
          host === "::1" ||
          host.endsWith(".localhost");
        if (!isLocal) {
          return {
            error:
              "open_browser requires a loopback URL; use browser_navigate or browser_new_tab for external sites.",
            url,
          };
        }
        const ok = ctx.openBrowser(url);
        if (!ok) return { error: "browser surface unavailable", url };
        return { url, ok: true };
      },
    }),
  } as const;
}
