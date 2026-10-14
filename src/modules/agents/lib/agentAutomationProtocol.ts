// The UI answers each request through ui_reply (uiReply.ts).
export const AGENT_REQUEST_EVENT = "anbo:agent-request";

export type TerminalAutomationMethod =
  | "terminal_open"
  | "terminal_close"
  | "terminal_list"
  | "terminal_read"
  | "terminal_insert"
  | "terminal_execute"
  | "terminal_wait"
  | "terminal_interrupt";

export type AgentAutomationMethod =
  | "agent_spawn"
  | "agent_list"
  | "agent_status"
  | "agent_read"
  | "agent_send"
  | "agent_wait"
  | TerminalAutomationMethod;

export type AgentAutomationRequest = {
  requestId: string;
  method: AgentAutomationMethod;
  params: Record<string, unknown>;
  /** When the caller stops waiting, in ms since the epoch. Nothing starts
   *  after it, so a caller told the operation timed out never has it happen. */
  deadline?: number;
};

export type AgentAutomationResponse = {
  result?: unknown;
  error?: { code: string; message: string };
};

export function automationError(
  code: string,
  message: string,
): AgentAutomationResponse {
  return { error: { code, message } };
}

/** Whether the caller of a request with `deadline` has stopped waiting. */
export function pastDeadline(
  deadline: number | undefined,
  now = Date.now(),
): boolean {
  return deadline !== undefined && now >= deadline;
}

/** The answer for a request that would have started after its caller stopped
 *  waiting. */
export function lateRequest(what: string): AgentAutomationResponse {
  return automationError(
    "timeout",
    `Anbo was too busy to ${what} before the request's deadline, so nothing was done. Try again.`,
  );
}

/** A non-blank string parameter, trimmed, or null. */
export function paramString(
  params: Record<string, unknown>,
  key: string,
): string | null {
  const value = params[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
