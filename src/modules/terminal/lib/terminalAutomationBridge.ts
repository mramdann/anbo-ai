import type {
  AgentAutomationResponse,
  TerminalAutomationMethod,
} from "@/modules/agents/lib/agentAutomationProtocol";

type TerminalAutomationHandler = (
  method: TerminalAutomationMethod,
  params: Record<string, unknown>,
) => Promise<AgentAutomationResponse>;

let handler: TerminalAutomationHandler | null = null;

export function setTerminalAutomationHandler(
  next: TerminalAutomationHandler | null,
): void {
  handler = next;
}

export function requestTerminalAutomation(
  method: TerminalAutomationMethod,
  params: Record<string, unknown>,
): Promise<AgentAutomationResponse> {
  if (!handler) {
    return Promise.resolve({
      error: {
        code: "terminal_unavailable",
        message: "shared terminal service is not ready",
      },
    });
  }
  return handler(method, params);
}
