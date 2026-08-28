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
        "Open a new normal Anbo terminal in this run's workspace without changing focus. A short purpose-specific tab title is required, such as Dev Server, Tests, or Build. Use terminal_execute with the returned terminalId after the shell becomes idle.",
      inputSchema: z.object({
        title: z.string().trim().min(1).max(64),
      }),
      needsApproval: true,
      execute: async ({ title }) =>
        sharedTerminalRequest("terminal_open", { title }),
    }),

    terminal_close: tool({
      description:
        "Close an idle normal terminal previously created by terminal_open in this application session. User-created terminals, agent CLI terminals, terminals with pending input, and terminals running a foreground process are never closed.",
      inputSchema: z.object({ terminalId: z.string().min(1) }),
      needsApproval: true,
      execute: async ({ terminalId }) =>
        sharedTerminalRequest("terminal_close", { terminalId }),
    }),

    terminal_list: tool({
      description:
        "List normal user-owned Anbo terminals in this run's workspace. Returns stable terminal ids, cwd, shell, dimensions, active state, and idle/busy status. Private terminals and agent CLI tabs are excluded. Use this before other terminal tools.",
      inputSchema: z.object({}),
      execute: async () => sharedTerminalRequest("terminal_list", {}),
    }),

    terminal_read: tool({
      description:
        "Read a redacted bounded increment from one shared normal Anbo terminal without changing workspace or focus. Reuse cursor for only newer output. hasMore and historyTruncated have distinct meanings; reset plus replayed identifies a buffer repaint.",
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
        "Wait for a command started by terminal_execute. Returns its stable phase, completionReason, interrupted flag, per-execution exitCode, and redacted bounded output. Completed results are idempotent; a timeout is a normal poll result.",
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
        "Cancel a specific queued, dispatched, or running terminal execution, or omit executionId to send Ctrl+C to the terminal's current foreground command or clear pending prompt input. Requires user approval and never changes workspace focus.",
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
        "Insert one single-line string into an explicitly selected idle user-owned Anbo terminal without pressing Enter or changing focus. Waits briefly for visible terminal echo and returns inputVisible plus a cursor for polling with terminal_read. Requires user approval.",
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
        "Queue one single-line shell command for visible, cancellable dispatch in an explicitly selected idle user-owned Anbo terminal. Returns an executionId in phase queued; use terminal_wait for its stable final result. Prompts containing unsubmitted input are rejected instead of concatenated.",
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
        "Propose a single shell command. Renders a card in chat with an 'Insert' button — the command is NOT written to any terminal automatically; only the user's click inserts it at the prompt without executing. Use this when the answer IS a command.",
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
        "Return the tail of the active terminal's scrollback. Use this when the user references 'this error', 'the last command', or you need to interpret recent terminal output. Default is 80 lines; raise it only when you genuinely need more. Returns an empty string if there is no active terminal; refuses if the terminal is in Privacy mode.",
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
        "Open a native browser tab at the given URL — restricted to localhost/loopback addresses for the local dev server. Use this after starting a dev server (e.g. `pnpm dev`, `npm run dev`) to surface the rendered page next to the terminal. To browse external sites, the user should paste the URL into the browser address bar themselves.",
      inputSchema: z.object({
        url: z
          .url()
          .describe(
            "Full URL to load (e.g. http://localhost:5173). Must include scheme. Only http/https on loopback hosts are accepted.",
          ),
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
              "open_browser is restricted to localhost URLs. Ask the user to paste the external URL into the browser address bar instead.",
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
