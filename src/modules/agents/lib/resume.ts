import type { PaneNode } from "@/modules/terminal/lib/panes";
import {
  AGENT_LAUNCHERS,
  type AgentInstanceCount,
  type AgentLauncherId,
} from "./launcher";

export type ResumableAgentId =
  | "claude"
  | "codex"
  | "antigravity"
  | "pi"
  | "opencode";

export type PersistedAgentResume = {
  agent: ResumableAgentId;
  command: string;
  sessionId?: string;
  relaunchOnRestore?: boolean;
};

export type AgentResumeState = PersistedAgentResume & {
  armed?: boolean;
  discoveryStartedAt?: number;
  resumeOnStart?: boolean;
};

export type AgentResumeLeaf = {
  id: number;
  cwd?: string;
  resume: AgentResumeState;
};

const EXACT_SESSION_AGENTS = new Set<ResumableAgentId>([
  "claude",
  "codex",
  "antigravity",
  "pi",
]);
const OPENCODE_SESSION_ID = /^ses_[A-Za-z0-9]+$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const LONG_SESSION_SELECTOR =
  /(?:^|\s)(?:--continue|--conversation|--resume|--session|--session-file|--session-id)(?:\s|=|$)/i;
const SHELL_OPERATOR = /&&|\|\||[;&|><`]/;

function isResumableAgentId(value: unknown): value is ResumableAgentId {
  return (
    typeof value === "string" &&
    (EXACT_SESSION_AGENTS.has(value as ResumableAgentId) ||
      value === "opencode")
  );
}

function canAttachSession(agent: ResumableAgentId, command: string): boolean {
  if (LONG_SESSION_SELECTOR.test(command) || SHELL_OPERATOR.test(command)) {
    return false;
  }
  if (agent === "codex" && /(?:^|\s)(?:resume|exec|e)(?:\s|$)/i.test(command)) {
    return false;
  }
  const shortSelector =
    agent === "opencode"
      ? /(?:^|\s)-[cs](?:\s|$)/i
      : agent === "antigravity"
        ? /(?:^|\s)-c(?:\s|$)/i
        : agent === "pi"
          ? /(?:^|\s)-[crs](?:\s|$)/i
          : /(?:^|\s)-[cr](?:\s|$)/i;
  if (shortSelector.test(command)) return false;
  const nonInteractive =
    agent === "claude"
      ? /(?:^|\s)(?:-p|--print|--no-session-persistence|--from-pr|--bg|--background)(?:\s|=|$)/i
      : agent === "antigravity"
        ? /(?:^|\s)(?:-p|--print|--prompt)(?:\s|=|$)/i
        : agent === "pi"
          ? /(?:^|\s)(?:-p|--print|--no-session|--fork)(?:\s|=|$)/i
          : /(?:^|\s)(?:run|attach|serve|web)(?:\s|$)/i;
  return !nonInteractive.test(command);
}

export function createAgentResumeStates(
  agent: AgentLauncherId,
  command: string,
  instances: AgentInstanceCount,
): Array<AgentResumeState | undefined> {
  if (!isResumableAgentId(agent) || !canAttachSession(agent, command)) {
    return Array.from({ length: instances }, () => undefined);
  }
  return Array.from({ length: instances }, () => ({
    agent,
    armed: false,
    command,
    discoveryStartedAt: Date.now(),
    relaunchOnRestore: true,
  }));
}

export function shouldPinAgentSession(
  agent: string,
): agent is ResumableAgentId {
  return isResumableAgentId(agent);
}

export function createManualAgentResumeState(
  agent: string,
  discoveryStartedAt: number,
): AgentResumeState | undefined {
  let resumableAgent: ResumableAgentId;
  let command: string;
  switch (agent) {
    case "claude":
    case "codex":
    case "opencode":
      resumableAgent = agent;
      command = agent;
      break;
    case "antigravity":
      resumableAgent = agent;
      command = "agy";
      break;
    default:
      return undefined;
  }
  return {
    agent: resumableAgent,
    command,
    armed: false,
    discoveryStartedAt,
    relaunchOnRestore: true,
  };
}

export function createAgentRestoreFallback(
  agent: AgentLauncherId,
): AgentResumeState | undefined {
  if (!isResumableAgentId(agent)) return undefined;
  const command = AGENT_LAUNCHERS.find(
    (launcher) => launcher.id === agent,
  )?.defaultCommand;
  if (!command || !canAttachSession(agent, command)) return undefined;
  return {
    agent,
    command,
    armed: true,
    relaunchOnRestore: true,
    resumeOnStart: true,
  };
}

export function normalizePersistedAgentResume(
  value: unknown,
): PersistedAgentResume | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  if (!isResumableAgentId(candidate.agent)) return undefined;
  if (
    typeof candidate.command !== "string" ||
    !candidate.command.trim() ||
    candidate.command.length > 256 ||
    CONTROL_CHARACTERS.test(candidate.command)
  ) {
    return undefined;
  }
  const command = candidate.command.trim();
  if (!canAttachSession(candidate.agent, command)) return undefined;
  let sessionId: string | undefined;
  if (candidate.sessionId !== undefined) {
    if (typeof candidate.sessionId !== "string") return undefined;
    const validSessionId =
      candidate.agent === "opencode"
        ? OPENCODE_SESSION_ID.test(candidate.sessionId)
        : UUID.test(candidate.sessionId);
    if (!validSessionId) return undefined;
    sessionId = candidate.sessionId;
  }
  const relaunchOnRestore = candidate.relaunchOnRestore === true;
  return {
    agent: candidate.agent,
    command,
    ...(sessionId && { sessionId }),
    ...(relaunchOnRestore && { relaunchOnRestore: true }),
  };
}

export function buildAgentLaunchCommand(
  _resume: PersistedAgentResume | undefined,
  fallbackCommand: string,
): string {
  return fallbackCommand;
}

export function buildAgentResumeCommand(
  resume: PersistedAgentResume,
): string | null {
  switch (resume.agent) {
    case "claude":
      return resume.sessionId
        ? `${resume.command} --resume ${resume.sessionId}`
        : null;
    case "codex":
      return resume.sessionId
        ? `${resume.command} resume ${resume.sessionId}`
        : null;
    case "antigravity":
      return resume.sessionId
        ? `${resume.command} --conversation ${resume.sessionId}`
        : null;
    case "pi":
      return resume.sessionId
        ? `${resume.command} --session ${resume.sessionId}`
        : null;
    case "opencode":
      return resume.sessionId
        ? `${resume.command} --session ${resume.sessionId}`
        : null;
  }
}

export function buildAgentRestoreCommand(
  resume: PersistedAgentResume,
): string | null {
  return buildAgentResumeCommand(resume) ??
    (resume.relaunchOnRestore ? resume.command : null);
}

export function collectAgentResumeLeaves(tree: PaneNode): AgentResumeLeaf[] {
  if (tree.kind === "leaf") {
    return tree.agentResume
      ? [{ id: tree.id, cwd: tree.cwd, resume: tree.agentResume }]
      : [];
  }
  return tree.children.flatMap(collectAgentResumeLeaves);
}
