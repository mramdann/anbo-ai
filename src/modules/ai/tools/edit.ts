import { tool } from "ai";
import { z } from "zod";
import { native } from "../lib/native";
import { newQueuedEditId, usePlanStore } from "../store/planStore";
import { djb2, type ToolContext } from "./context";
import { writeTargets } from "./writeTargets";

type Edit = { old_string: string; new_string: string; replace_all?: boolean };
type EditKind = "edit" | "multi_edit";

type EditResult =
  | { ok: true; replacements: number; bytesWritten: number; path: string }
  | { error: string; path: string };

async function applyEdits(
  abs: string,
  edits: Edit[],
  kind: EditKind,
  ctx: ToolContext,
): Promise<EditResult> {
  const r = await native.readFile(abs, ctx.getWorkspaceEnv());
  if (r.kind === "binary") return { error: "binary file refused", path: abs };
  if (r.kind === "toolarge")
    return { error: `file too large (${r.size} bytes)`, path: abs };

  const original = r.content;
  let content = original;
  let replacements = 0;

  for (const e of edits) {
    if (e.old_string === e.new_string) {
      return {
        error: "old_string and new_string are identical",
        path: abs,
      };
    }
    if (e.old_string.length === 0) {
      return { error: "old_string cannot be empty", path: abs };
    }
    const first = content.indexOf(e.old_string);
    if (first === -1) {
      return {
        error: `old_string not found: ${JSON.stringify(e.old_string.slice(0, 80))}`,
        path: abs,
      };
    }
    if (e.replace_all) {
      const parts = content.split(e.old_string);
      replacements += parts.length - 1;
      content = parts.join(e.new_string);
    } else {
      if (content.indexOf(e.old_string, first + 1) !== -1) {
        return {
          error:
            "old_string is not unique. Provide more surrounding context, or set replace_all=true.",
          path: abs,
        };
      }
      content =
        content.slice(0, first) +
        e.new_string +
        content.slice(first + e.old_string.length);
      replacements += 1;
    }
  }

  const done = {
    ok: true as const,
    replacements,
    bytesWritten: content.length,
    path: abs,
  };
  if (usePlanStore.getState().active) {
    usePlanStore.getState().enqueue({
      id: newQueuedEditId(),
      kind,
      path: abs,
      originalContent: original,
      proposedContent: content,
      isNewFile: false,
      expectedVersion: r.version,
    });
    return done;
  }

  try {
    await native.writeFile(abs, content, ctx.getWorkspaceEnv(), r.version);
    ctx.readCache.set(abs, { size: content.length, hash: djb2(content) });
    return done;
  } catch (err) {
    return { error: String(err), path: abs };
  }
}

export function buildEditTools(ctx: ToolContext) {
  const targets = writeTargets(ctx);
  const editFile = async (
    path: string,
    edits: Edit[],
    kind: EditKind,
  ): Promise<EditResult> => {
    const { reqPath, target } = targets.resolve(path);
    const safety = await target;
    if (!safety.ok) return { error: safety.reason, path: reqPath };
    const abs = safety.canonical;
    if (!ctx.readCache.has(abs)) {
      return {
        error:
          "must call read_file on this path first (read-before-edit invariant).",
        path: abs,
      };
    }
    return applyEdits(abs, edits, kind, ctx);
  };
  const tools = {
    edit: tool({
      description:
        "Replace an exact string in a file. Requires read_file on this path first in the current session — this prevents blind edits. `old_string` must be unique in the file unless `replace_all: true`. Asks for user approval before writing.",
      inputSchema: z.object({
        path: z.string(),
        old_string: z
          .string()
          .describe(
            "Exact substring to replace. Must be unique unless replace_all.",
          ),
        new_string: z.string().describe("Replacement substring."),
        replace_all: z.boolean().optional(),
      }),
      execute: ({ path, old_string, new_string, replace_all }) =>
        editFile(path, [{ old_string, new_string, replace_all }], "edit"),
    }),

    multi_edit: tool({
      description:
        "Apply several exact-string replacements to a single file atomically. Each edit is applied in order to the running buffer; if any edit's old_string is missing or non-unique, the whole batch aborts before writing. Requires prior read_file on the path. Asks for user approval before writing.",
      inputSchema: z.object({
        path: z.string(),
        edits: z
          .array(
            z.object({
              old_string: z.string(),
              new_string: z.string(),
              replace_all: z.boolean().optional(),
            }),
          )
          .min(1),
      }),
      execute: ({ path, edits }) => editFile(path, edits, "multi_edit"),
    }),
  } as const;
  return {
    tools,
    approval: { edit: targets.approve, multi_edit: targets.approve },
  };
}
