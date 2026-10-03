import { buildManagedAgentTools } from "./agent";
import { buildBrowserTools } from "./browser";
import { buildEditTools } from "./edit";
import { buildFsTools } from "./fs";
import { buildSearchTools } from "./search";
import { buildShellTools } from "./shell";
import { buildSubagentTools } from "./subagent";
import { buildTerminalTools } from "./terminal";
import { buildTodoTools } from "./todo";

export { resolvePath, type ToolContext } from "./context";

/**
 * AI tool definitions.
 *
 * Approval policy:
 *  - Read-only tools (`read_file`, `list_directory`, `grep`, `glob`)
 *    auto-execute, but go through the security guard which refuses obvious
 *    secret paths (.env*, .ssh/, credentials, etc.).
 *  - Mutating tools (`write_file`, `edit`, `multi_edit`, `create_directory`,
 *    shell, terminal, agent and tab-closing tools) require explicit user
 *    approval. Each builder lists them in its `approval` map, which the call
 *    passes as `toolApproval` (AI SDK 7 sets approval on the call, not on the
 *    tool); the SDK then pauses on the tool call and surfaces a
 *    `tool-approval-request` part that the UI renders as a confirmation card.
 *  - `edit` / `multi_edit` additionally enforce a read-before-edit invariant
 *    (the model must have called read_file on the path earlier in the
 *    session).
 *
 * The model sees absolute paths only after they are resolved against the
 * active terminal's cwd (provided via `getCwd`); it should not invent paths
 * outside that.
 */
export function buildTools(ctx: import("./context").ToolContext) {
  const fs = buildFsTools(ctx);
  const edit = buildEditTools(ctx);
  const shell = buildShellTools(ctx);
  const terminal = buildTerminalTools(ctx);
  const agents = buildManagedAgentTools(ctx);
  const browser = buildBrowserTools(ctx);
  return {
    tools: {
      ...fs.tools,
      ...edit.tools,
      ...buildSearchTools(ctx),
      ...shell.tools,
      ...buildSubagentTools(ctx),
      ...terminal.tools,
      ...buildTodoTools(ctx),
      ...agents.tools,
      ...browser.tools,
    },
    approval: {
      ...fs.approval,
      ...edit.approval,
      ...shell.approval,
      ...terminal.approval,
      ...agents.approval,
      ...browser.approval,
    },
  } as const;
}
