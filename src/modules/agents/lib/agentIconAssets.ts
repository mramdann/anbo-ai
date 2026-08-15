export type AgentBrandAsset = {
  light: string;
  dark?: string;
  invertOnDark?: boolean;
};

export const AGENT_BRAND_ASSETS = {
  claude: { light: "/agent-icons/claude.svg" },
  codex: { light: "/agent-icons/codex.svg", invertOnDark: true },
  antigravity: { light: "/agent-icons/antigravity.png" },
  pi: { light: "/agent-icons/pi.svg" },
  opencode: {
    light: "/agent-icons/opencode-light.svg",
    dark: "/agent-icons/opencode-dark.svg",
  },
  grok: {
    light: "/agent-icons/grok-build-light.svg",
    dark: "/agent-icons/grok-build-dark.svg",
  },
} as const satisfies Record<string, AgentBrandAsset>;

export type AgentBrandId = keyof typeof AGENT_BRAND_ASSETS;

export function resolveAgentBrandId(agent: string): AgentBrandId | null {
  const normalized = agent.trim().toLowerCase();
  if (normalized.includes("claude")) return "claude";
  if (
    normalized.includes("codex") ||
    normalized.includes("gpt") ||
    normalized.includes("openai")
  ) {
    return "codex";
  }
  if (normalized.includes("antigravity") || normalized === "agy") {
    return "antigravity";
  }
  if (normalized === "pi") return "pi";
  if (normalized.includes("opencode")) return "opencode";
  if (normalized.includes("grok")) return "grok";
  return null;
}

export function resolveAgentBrandAsset(agent: string): AgentBrandAsset | null {
  const id = resolveAgentBrandId(agent);
  return id ? AGENT_BRAND_ASSETS[id] : null;
}
