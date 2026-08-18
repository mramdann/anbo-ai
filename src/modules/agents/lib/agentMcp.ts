import { quoteShellArg } from "@/lib/shellQuote";
import type { AgentLauncherId } from "./launcher";

export const MCP_AGENT_IDS = [
  "claude",
  "codex",
  "antigravity",
  "opencode",
] as const;

export type McpAgentId = (typeof MCP_AGENT_IDS)[number];
export type AgentMcpEnabled = Record<McpAgentId, boolean>;

export const DEFAULT_AGENT_MCP_ENABLED: AgentMcpEnabled = {
  claude: true,
  codex: true,
  antigravity: true,
  opencode: true,
};

export function isMcpAgentId(agent: string): agent is McpAgentId {
  return (MCP_AGENT_IDS as readonly string[]).includes(agent);
}

export function normalizeAgentMcpEnabled(value: unknown): AgentMcpEnabled {
  const stored =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : {};
  return Object.fromEntries(
    MCP_AGENT_IDS.map((agent) => [
      agent,
      typeof stored[agent] === "boolean"
        ? stored[agent]
        : DEFAULT_AGENT_MCP_ENABLED[agent],
    ]),
  ) as AgentMcpEnabled;
}

function workspaceFile(root: string, ...parts: string[]): string {
  const separator = root.includes("\\") ? "\\" : "/";
  return [root.replace(/[\\/]+$/, ""), ...parts].join(separator);
}

/**
 * Add only the runtime wiring required by agents whose project-local MCP file
 * is loaded through a CLI option/environment variable. The persisted start
 * command remains untouched so resume metadata never accumulates injections.
 */
export function withAgentMcpRuntime(
  agent: AgentLauncherId,
  command: string,
  workspaceRoot: string,
  localWindows: boolean,
): string {
  // A compound custom command may hand control to a wrapper or a second
  // executable. Appending CLI options would change its meaning.
  if (/&&|\|\||[;&|><`]/.test(command)) return command;
  if (agent === "claude") {
    if (/(?:^|\s)--mcp-config(?:\s|=|$)/i.test(command)) return command;
    return `${command} --mcp-config .claude/anbo-mcp.json`;
  }
  if (agent === "opencode") {
    if (/(?:^|\s)(?:\$env:|export\s+)?OPENCODE_CONFIG\s*=/i.test(command)) {
      return command;
    }
    const config = workspaceFile(workspaceRoot, ".opencode", "anbo-mcp.json");
    const quoted = quoteShellArg(config, localWindows);
    return localWindows
      ? `$env:OPENCODE_CONFIG=${quoted}; ${command}`
      : `OPENCODE_CONFIG=${quoted} ${command}`;
  }
  return command;
}
