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
 * How long a turn has run or took, in one unit a glance can read: seconds
 * under a minute ("12s"), whole minutes from then on ("10m").
 */
export function formatAgentDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m`;
}
