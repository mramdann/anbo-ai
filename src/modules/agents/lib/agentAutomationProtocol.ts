export const AGENT_REQUEST_EVENT = "anbo:agent-request";
export const AGENT_RESPONSE_EVENT = "anbo:agent-response";

export type AgentAutomationMethod =
  | "agent_spawn"
  | "agent_list"
  | "agent_status"
  | "agent_read"
  | "agent_send"
  | "agent_wait";

export type AgentAutomationRequest = {
  requestId: string;
  method: AgentAutomationMethod;
  params: Record<string, unknown>;
};

export type AgentAutomationResponse = {
  result?: unknown;
  error?: { code: string; message: string };
};
