const LABELS: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  antigravity: "Antigravity",
  pi: "Pi",
  opencode: "OpenCode",
  kimi: "Kimi Code",
  grok: "Grok",
  anbo: "Anbo",
};

export function displayAgent(agent: string): string {
  if (!agent) return "Agent";
  return (
    LABELS[agent.toLowerCase()] ??
    agent.charAt(0).toUpperCase() + agent.slice(1)
  );
}

export function displayAgentInstance(
  agent: string,
  instanceName?: string | null,
): string {
  const name = instanceName?.trim();
  return name || displayAgent(agent);
}

/**
 * How long a turn has run or took, to the precision a glance needs: seconds
 * under a minute, minutes and seconds under an hour, hours and minutes after.
 */
export function formatAgentDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${total % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
