import { tool } from "ai";
import { z } from "zod";
import { EXPECTED_MISSING_VERSION, native } from "../lib/native";
import { checkReadableCanonical } from "../lib/security";
import { newQueuedEditId, usePlanStore } from "../store/planStore";
import { djb2, resolvePath, type ToolContext } from "./context";
import { writeTargets } from "./writeTargets";

const READ_BYTE_CAP = 25 * 1024;
const READ_LINE_CAP = 2000;

export function buildFsTools(ctx: ToolContext) {
  const workspace = ctx.getWorkspaceEnv();
  const canonicalize = (path: string) => native.canonicalize(path, workspace);
  const targets = writeTargets(ctx);
  const tools = {
    read_file: tool({
      description:
        "Read a UTF-8 text file. Defaults to the first 2000 lines (capped at 25KB). Pass `offset`/`limit` for line-based windowing of large files. Refuses binary, oversized, or sensitive files (.env, keys, credentials). If you call this on the same path twice in a session without edits in between, the second call returns `unchanged: true` instead of re-emitting the content — re-read the prior tool result.",
      inputSchema: z.object({
        path: z
          .string()
          .describe("Absolute path, or relative to the active terminal cwd."),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("0-based start line. Default 0."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(10000)
          .optional()
          .describe("Max lines to return. Default 2000."),
      }),
      execute: async ({ path, offset, limit }) => {
        const reqPath = resolvePath(path, ctx.getCwd());
        const safety = await checkReadableCanonical(reqPath, canonicalize);
        if (!safety.ok) return { error: safety.reason, path: reqPath };
        const abs = safety.canonical;
        try {
          const r = await native.readFile(abs, workspace);
          if (r.kind === "binary")
            return { error: "binary file refused", path: abs, size: r.size };
          if (r.kind === "toolarge")
            return {
              error: `file too large (${r.size} bytes, limit ${r.limit})`,
              path: abs,
            };

          const hash = djb2(r.content);
          const isFullRead = offset === undefined && limit === undefined;
          const prior = ctx.readCache.get(abs);
          if (
            isFullRead &&
            prior &&
            prior.size === r.size &&
            prior.hash === hash
          ) {
            return { path: abs, unchanged: true, size: r.size };
          }
          ctx.readCache.set(abs, { size: r.size, hash });

          const lines = r.content.split("\n");
          const start = offset ?? 0;
          const end = Math.min(lines.length, start + (limit ?? READ_LINE_CAP));
          let content = lines.slice(start, end).join("\n");
          let truncated = end < lines.length;
          if (content.length > READ_BYTE_CAP) {
            content = content.slice(0, READ_BYTE_CAP);
            truncated = true;
          }
          const page = {
            path: abs,
            content,
            size: r.size,
            total_lines: lines.length,
          };
          if (isFullRead) {
            return {
              ...page,
              ...(truncated
                ? {
                    truncated: true,
                    hint: "call read_file with offset to continue",
                  }
                : {}),
            };
          }
          return {
            ...page,
            start_line: start,
            end_line: end,
            ...(truncated ? { truncated: true } : {}),
          };
        } catch (e) {
          return { error: String(e), path: abs };
        }
      },
    }),

    list_directory: tool({
      description:
        "List immediate entries (files + directories) in a directory. Hidden entries are omitted.",
      inputSchema: z.object({
        path: z
          .string()
          .describe("Absolute path, or relative to the active terminal cwd."),
      }),
      execute: async ({ path }) => {
        const reqPath = resolvePath(path, ctx.getCwd());
        const safety = await checkReadableCanonical(reqPath, canonicalize);
        if (!safety.ok) return { error: safety.reason, path: reqPath };
        const abs = safety.canonical;
        try {
          const entries = await native.readDir(abs, workspace);
          return {
            path: abs,
            entries: entries.map((e) => ({ name: e.name, kind: e.kind })),
          };
        } catch (e) {
          return { error: String(e), path: abs };
        }
      },
    }),

    write_file: tool({
      description:
        "Create or overwrite a file with the given content. Always asks the user before running. Prefer `edit` / `multi_edit` for in-place changes — only use `write_file` for creating a brand-new file or fully replacing a tiny one.",
      inputSchema: z.object({
        path: z.string(),
        content: z.string(),
      }),
      execute: async ({ path, content }) => {
        const { reqPath, target } = targets.resolve(path);
        const safety = await target;
        if (!safety.ok) return { error: safety.reason, path: reqPath };
        const abs = safety.canonical;

        let original = "";
        let isNewFile = false;
        let expectedVersion = EXPECTED_MISSING_VERSION;
        try {
          const current = await native.readFile(abs, workspace);
          if (current.kind !== "text") {
            return {
              error:
                "write_file only replaces existing text files; binary or oversized files are refused",
              path: abs,
            };
          }
          original = current.content;
          expectedVersion = current.version;
        } catch {
          isNewFile = true;
        }

        if (usePlanStore.getState().active) {
          usePlanStore.getState().enqueue({
            id: newQueuedEditId(),
            kind: "write_file",
            path: abs,
            originalContent: original,
            proposedContent: content,
            isNewFile,
            expectedVersion,
          });
          return {
            path: abs,
            queued_for_plan_review: true,
            ok: true,
          };
        }

        try {
          await native.writeFile(abs, content, workspace, expectedVersion);
          ctx.readCache.set(abs, { size: content.length, hash: djb2(content) });
          return { path: abs, bytesWritten: content.length, ok: true };
        } catch (e) {
          return { error: String(e), path: abs };
        }
      },
    }),

    create_directory: tool({
      description:
        "Create a directory (and any missing parents). Always asks the user before running.",
      inputSchema: z.object({
        path: z.string(),
      }),
      execute: async ({ path }) => {
        const { reqPath, target } = targets.resolve(path);
        const safety = await target;
        if (!safety.ok) return { error: safety.reason, path: reqPath };
        const abs = safety.canonical;
        if (usePlanStore.getState().active) {
          usePlanStore.getState().enqueue({
            id: newQueuedEditId(),
            kind: "create_directory",
            path: abs,
            originalContent: "",
            proposedContent: "",
            isNewFile: true,
            description: "Create directory",
          });
          return { path: abs, queued_for_plan_review: true, ok: true };
        }
        try {
          await native.createDir(abs, workspace);
          return { path: abs, ok: true };
        } catch (e) {
          return { error: String(e), path: abs };
        }
      },
    }),
  } as const;
  return {
    tools,
    approval: {
      write_file: targets.approve,
      create_directory: targets.approve,
    },
  };
}
