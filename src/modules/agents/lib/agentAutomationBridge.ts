import {
  AGENT_REQUEST_EVENT,
  type AgentAutomationRequest,
} from "@/modules/agents/lib/agentAutomationProtocol";
import { listen } from "@tauri-apps/api/event";

type AgentRequestHandler = (request: AgentAutomationRequest) => void;
type AgentBridge = ReturnType<typeof createAgentRequestListener>;
type AgentAutomationWindow = Window & { __anboAgentBridge?: AgentBridge };

export function createAgentRequestListener(
  subscribe: (handler: AgentRequestHandler) => Promise<() => void>,
) {
  let handler: AgentRequestHandler | null = null;
  let subscription: Promise<void> | null = null;
  let unlisten: (() => void) | null = null;
  let generation = 0;

  const start = () => {
    if (subscription || unlisten) return;
    const currentGeneration = generation;
    subscription = subscribe((request) => handler?.(request))
      .then((dispose) => {
        subscription = null;
        if (generation !== currentGeneration) {
          dispose();
          return;
        }
        unlisten = dispose;
      })
      .catch(() => {
        subscription = null;
      });
  };

  return {
    setHandler(next: AgentRequestHandler) {
      handler = next;
      start();
    },
    stop() {
      generation += 1;
      handler = null;
      unlisten?.();
      unlisten = null;
      subscription = null;
    },
  };
}

const agentWindow = window as AgentAutomationWindow;
const bridge =
  agentWindow.__anboAgentBridge ??
  createAgentRequestListener((handler) =>
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
