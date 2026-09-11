import type {
  AgentAutomationMethod,
  AgentAutomationResponse,
} from "@/modules/agents/lib/agentAutomationProtocol";

type TerminalAutomationHandler = (
  method: AgentAutomationMethod,
  params: Record<string, unknown>,
) => Promise<AgentAutomationResponse>;

let handler: TerminalAutomationHandler | null = null;

export function setTerminalAutomationHandler(
  next: TerminalAutomationHandler | null,
): void {
  handler = next;
}

/**
 * The in-process route to the shared terminal and agent service: the same
 * handler that answers MCP, without the Rust round trip. Terminal and agent
 * methods both land here because the service routes by prefix.
 */
export function requestTerminalAutomation(
  method: AgentAutomationMethod,
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
