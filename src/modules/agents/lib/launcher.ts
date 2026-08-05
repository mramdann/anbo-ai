import type { PaneNode } from "@/modules/terminal";

export const AGENT_LAUNCHERS = [
  {
    id: "claude",
    icon: "claude",
    label: "Claude",
    defaultCommand: "claude",
    supportsHooks: true,
    custom: false,
  },
  {
    id: "codex",
    icon: "codex",
    label: "Codex",
    defaultCommand: "codex",
    supportsHooks: true,
    custom: false,
  },
  {
    id: "gemini",
    icon: "gemini",
    label: "Gemini",
    defaultCommand: "gemini",
    supportsHooks: true,
    custom: false,
  },
  {
    id: "pi",
    icon: "pi",
    label: "Pi",
    defaultCommand: "pi",
    supportsHooks: true,
    custom: false,
  },
  {
    id: "opencode",
    icon: "opencode",
    label: "OpenCode",
    defaultCommand: "opencode",
    supportsHooks: false,
    custom: false,
  },
  {
    id: "grok",
    icon: "grok",
    label: "Grok",
    defaultCommand: "grok",
    supportsHooks: false,
    custom: false,
  },
] as const;

export type BuiltInAgentLauncherId = (typeof AGENT_LAUNCHERS)[number]["id"];
export const CUSTOM_CLI_AGENT_ICONS = [
  "robot",
  "claude",
  "codex",
  "gemini",
  "pi",
  "opencode",
  "grok",
] as const;
export type CustomCliAgentIcon = (typeof CUSTOM_CLI_AGENT_ICONS)[number];
export type CustomCliAgentId = `custom:${string}`;
export type AgentLauncherId = BuiltInAgentLauncherId | CustomCliAgentId;
export type AgentInstanceCount = 1 | 2 | 3 | 4;
export type AgentLaunchCommands = Record<BuiltInAgentLauncherId, string>;

export type CustomCliAgent = {
  id: CustomCliAgentId;
  icon: CustomCliAgentIcon;
  name: string;
  command: string;
};

export type AgentLauncher = {
  id: AgentLauncherId;
  icon: CustomCliAgentIcon;
  label: string;
  defaultCommand: string;
  supportsHooks: boolean;
  custom: boolean;
};

export type AgentLaunchRequest = {
  agent: AgentLauncherId;
  command: string;
  instances: AgentInstanceCount;
};

export const DEFAULT_AGENT_LAUNCH_COMMANDS: AgentLaunchCommands =
  Object.fromEntries(
    AGENT_LAUNCHERS.map((agent) => [agent.id, agent.defaultCommand]),
  ) as AgentLaunchCommands;

const MAX_AGENT_COMMAND_LENGTH = 256;
const MAX_CUSTOM_AGENT_NAME_LENGTH = 64;
const MAX_CUSTOM_CLI_AGENTS = 32;
const CUSTOM_AGENT_ID = /^custom:[a-z0-9][a-z0-9-]{0,63}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

function isCustomCliAgentIcon(value: unknown): value is CustomCliAgentIcon {
  return (
    typeof value === "string" &&
    (CUSTOM_CLI_AGENT_ICONS as readonly string[]).includes(value)
  );
}

export type AgentCommandValidation =
  | { ok: true; command: string }
  | { ok: false; error: string };

export function validateAgentLaunchCommand(
  value: unknown,
): AgentCommandValidation {
  if (typeof value !== "string") {
    return { ok: false, error: "Enter a start command." };
  }
  const command = value.trim();
  if (!command) return { ok: false, error: "Enter a start command." };
  if (command.length > MAX_AGENT_COMMAND_LENGTH) {
    return {
      ok: false,
      error: `Keep the command under ${MAX_AGENT_COMMAND_LENGTH} characters.`,
    };
  }
  if (CONTROL_CHARACTERS.test(command)) {
    return { ok: false, error: "Use a single-line command." };
  }
  return { ok: true, command };
}

export function normalizeAgentLaunchCommands(
  value: unknown,
): AgentLaunchCommands {
  const stored =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : {};
  return Object.fromEntries(
    AGENT_LAUNCHERS.map((agent) => {
      const result = validateAgentLaunchCommand(stored[agent.id]);
      return [
        agent.id,
        result.ok ? result.command : agent.defaultCommand,
      ] as const;
    }),
  ) as AgentLaunchCommands;
}

export type CustomAgentNameValidation =
  | { ok: true; name: string }
  | { ok: false; error: string };

export function validateCustomCliAgentName(
  value: unknown,
  existing: readonly CustomCliAgent[] = [],
  currentId?: string,
): CustomAgentNameValidation {
  if (typeof value !== "string") {
    return { ok: false, error: "Enter an agent name." };
  }
  const name = value.trim();
  if (!name) return { ok: false, error: "Enter an agent name." };
  if (name.length > MAX_CUSTOM_AGENT_NAME_LENGTH) {
    return {
      ok: false,
      error: `Keep the name under ${MAX_CUSTOM_AGENT_NAME_LENGTH} characters.`,
    };
  }
  if (CONTROL_CHARACTERS.test(name)) {
    return { ok: false, error: "Use a single-line name." };
  }
  const folded = name.toLocaleLowerCase();
  if (
    AGENT_LAUNCHERS.some(
      (agent) =>
        agent.id.toLocaleLowerCase() === folded ||
        agent.label.toLocaleLowerCase() === folded,
    )
  ) {
    return { ok: false, error: "That name belongs to a built-in agent." };
  }
  if (
    existing.some(
      (agent) =>
        agent.id !== currentId && agent.name.toLocaleLowerCase() === folded,
    )
  ) {
    return { ok: false, error: "An agent with that name already exists." };
  }
  return { ok: true, name };
}

export function newCustomCliAgentId(): CustomCliAgentId {
  return `custom:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function normalizeCustomCliAgents(value: unknown): CustomCliAgent[] {
  if (!Array.isArray(value)) return [];
  const result: CustomCliAgent[] = [];
  const ids = new Set<string>();
  for (const candidate of value) {
    if (result.length >= MAX_CUSTOM_CLI_AGENTS) break;
    if (typeof candidate !== "object" || candidate === null) continue;
    const stored = candidate as Record<string, unknown>;
    if (
      typeof stored.id !== "string" ||
      !CUSTOM_AGENT_ID.test(stored.id) ||
      ids.has(stored.id)
    ) {
      continue;
    }
    const name = validateCustomCliAgentName(stored.name, result);
    const command = validateAgentLaunchCommand(stored.command);
    if (!name.ok || !command.ok) continue;
    ids.add(stored.id);
    result.push({
      id: stored.id as CustomCliAgentId,
      icon: isCustomCliAgentIcon(stored.icon) ? stored.icon : "robot",
      name: name.name,
      command: command.command,
    });
  }
  return result;
}

export function isBuiltInAgentLauncherId(
  id: string,
): id is BuiltInAgentLauncherId {
  return AGENT_LAUNCHERS.some((agent) => agent.id === id);
}

export function getAgentLaunchers(
  customAgents: readonly CustomCliAgent[],
): AgentLauncher[] {
  return [
    ...AGENT_LAUNCHERS,
    ...normalizeCustomCliAgents(customAgents).map((agent) => ({
      id: agent.id,
      icon: agent.icon,
      label: agent.name,
      defaultCommand: agent.command,
      supportsHooks: false,
      custom: true,
    })),
  ];
}

export function findAgentLauncher(
  id: string,
  customAgents: readonly CustomCliAgent[] = [],
): AgentLauncher | undefined {
  return getAgentLaunchers(customAgents).find((agent) => agent.id === id);
}

export type AgentPanePlan = {
  paneTree: PaneNode;
  leafIds: number[];
};

export function createAgentPanePlan(
  instances: AgentInstanceCount,
  allocateId: () => number,
  cwd?: string,
): AgentPanePlan {
  if (!Number.isInteger(instances) || instances < 1 || instances > 4) {
    throw new RangeError("Agent instance count must be between 1 and 4.");
  }

  const leaves = Array.from({ length: instances }, () => ({
    kind: "leaf" as const,
    id: allocateId(),
    cwd,
  }));
  const split = (dir: "row" | "col", children: PaneNode[]): PaneNode => ({
    kind: "split",
    id: allocateId(),
    dir,
    children,
  });

  switch (instances) {
    case 1:
      return { paneTree: leaves[0], leafIds: leaves.map((leaf) => leaf.id) };
    case 2:
      return {
        paneTree: split("row", leaves),
        leafIds: leaves.map((leaf) => leaf.id),
      };
    case 3:
      return {
        paneTree: split("row", [
          leaves[0],
          split("col", [leaves[1], leaves[2]]),
        ]),
        leafIds: leaves.map((leaf) => leaf.id),
      };
    case 4:
      return {
        paneTree: split("row", [
          split("col", [leaves[0], leaves[1]]),
          split("col", [leaves[2], leaves[3]]),
        ]),
        leafIds: leaves.map((leaf) => leaf.id),
      };
  }
}
