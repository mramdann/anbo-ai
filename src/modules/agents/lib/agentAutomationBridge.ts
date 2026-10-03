import {
  createRequestListener,
  type RequestListener,
} from "@/lib/requestListener";
import {
  AGENT_REQUEST_EVENT,
  type AgentAutomationRequest,
} from "@/modules/agents/lib/agentAutomationProtocol";
import { listen } from "@tauri-apps/api/event";

type AgentRequestHandler = (request: AgentAutomationRequest) => void;
type AgentAutomationWindow = Window & {
  __anboAgentBridge?: RequestListener<AgentAutomationRequest>;
};

const agentWindow = window as AgentAutomationWindow;
const bridge =
  agentWindow.__anboAgentBridge ??
  createRequestListener<AgentAutomationRequest>((handler) =>
    listen<AgentAutomationRequest>(AGENT_REQUEST_EVENT, ({ payload }) =>
      handler(payload),
    ),
  );

if (!agentWindow.__anboAgentBridge) {
  agentWindow.__anboAgentBridge = bridge;
  window.addEventListener("beforeunload", () => bridge.stop(), { once: true });
}

export function setAgentRequestHandler(handler: AgentRequestHandler): void {
  bridge.setHandler(handler);
}
