import brandAssets from "@/modules/agents/lib/agentIconAssets.json";

export type AgentBrandAsset = {
  light: string;
  dark?: string;
  invertOnDark?: boolean;
};

export const AGENT_BRAND_ASSETS = brandAssets satisfies Record<
  string,
  AgentBrandAsset
>;

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
