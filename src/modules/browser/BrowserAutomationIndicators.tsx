import { useAgentCallsign } from "@/modules/agents/lib/agentCallsign";
import { AgentIcon } from "@/modules/agents/lib/agentIcon";
import { useBrowserAutomationParticipants } from "./automationActivity";
import { automationLabel, type AutomationState } from "./automationState";

function Participant({
  state,
  hidden,
}: {
  state: AutomationState;
  hidden: boolean;
}) {
  const callsign = useAgentCallsign(state.actor.ptyId);
  const name = callsign ?? `${state.actor.label} (session ${state.controlId})`;
  const title = `${name}: ${automationLabel(state)}`;
  return (
    <span
      className={hidden ? "sr-only" : "anbo-browser-automation-indicator"}
      title={title}
      role="img"
      aria-label={title}
      data-phase={state.phase}
      data-state={
        state.phase === "idle"
          ? "idle"
          : ["done", "error", "queued"].includes(state.phase)
            ? "held"
            : "acting"
      }
    >
      {hidden ? (
        title
      ) : (
        <AgentIcon
          agent={state.actor.brand}
          size={12}
          className="anbo-browser-automation-robot"
        />
      )}
    </span>
  );
}

export function BrowserAutomationIndicators({ tabId }: { tabId: number }) {
  const participants = useBrowserAutomationParticipants(tabId);
  if (!participants.length) return null;
  return (
    <span
      data-no-drag
      role="status"
      className="anbo-browser-automation-participants"
      aria-label={`${participants.length} ${participants.length === 1 ? "agent" : "agents"} controlling this tab`}
    >
      {participants.map((state, index) => (
        <Participant key={state.controlId} state={state} hidden={index >= 2} />
      ))}
      {participants.length > 1 && (
        <span
          className="anbo-browser-automation-count"
          title={`${participants.length} agents controlling this tab`}
        >
          {participants.length > 2 ? `+${participants.length - 2}` : "2"}
        </span>
      )}
    </span>
  );
}
