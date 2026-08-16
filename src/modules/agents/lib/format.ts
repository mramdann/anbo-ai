const LABELS: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  antigravity: "Antigravity",
  pi: "Pi",
  opencode: "OpenCode",
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
