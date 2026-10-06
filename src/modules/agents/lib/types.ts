export type AgentStatus = "working" | "waiting";
export type AgentPhase = "working" | "attention" | "finished";

export type AgentSource = "terminal" | "local";

type AgentSignalKind = "started" | "attention" | "exited";

export type AgentSignal = {
  id: number;
  kind: AgentSignalKind;
  agent: string | null;
  sessionId?: string;
};

export type AgentSession = {
  leafId: number;
  tabId: number;
  agent: string;
  name: string;
  status: AgentStatus;
  phase: AgentPhase;
  startedAt: number;
  lastActivityAt: number;
  attentionSince: number | null;
  /** When the turn in progress began; null when the agent is not in a turn. */
  turnStartedAt?: number | null;
  /** Work left running while the agent waits, e.g. "1 shell". */
  background?: string | null;
};

/** What a status change carries besides the status itself. */
export type AgentStatusDetail = {
  turnStartedAt?: number | null;
  background?: string | null;
};

export type AgentNotification = {
  id: string;
  source: AgentSource;
  leafId: number;
  tabId: number;
  agent: string;
  name: string;
  kind: NotificationKind;
  at: number;
  read: boolean;
  /** How long the finished turn took. */
  durationMs?: number | null;
};

export type NotificationKind = "attention" | "finished" | "error";

export type LocalAgentState = {
  agent: string;
  status: AgentStatus;
} | null;
