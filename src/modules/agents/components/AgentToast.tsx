import { shortcutLabel } from "@/modules/shortcuts";
import { toast } from "sonner";
import { AgentIcon } from "../lib/agentIcon";
import { displayAgent } from "../lib/format";

type AgentToastArgs = {
  agent: string;
  title: string;
  body?: string;
  workspace?: string;
  onActivate: () => void;
};

export function showAgentToast({
  agent,
  title,
  body,
  workspace,
  onActivate,
}: AgentToastArgs) {
  const hint = shortcutLabel("agent.focusAttention");
  const detail = [displayAgent(agent), workspace, body]
    .filter(Boolean)
    .join(" · ");
  void import("../lib/attentionSound")
    .then(({ playAttentionSound }) => playAttentionSound())
    .catch(() => {});
  toast(title, {
    description: detail ? (
      hint ? (
        <span className="flex items-center gap-1.5">
          <span className="min-w-0 truncate">{detail}</span>
          <kbd className="ml-auto shrink-0 rounded border border-border/60 bg-muted/60 px-1 py-px text-[10px] font-medium text-muted-foreground">
            {hint}
          </kbd>
        </span>
      ) : (
        detail
      )
    ) : undefined,
    icon: <AgentIcon agent={agent} size={18} />,
    action: {
      label: "Open",
      onClick: (event) => {
        event?.preventDefault?.();
        onActivate();
      },
    },
    // The alert stands for thirty seconds, and Open jumps to the agent, so
    // without this there is no way to put the alert away and stay put.
    closeButton: true,
    // Sonner pins the close button to the text-direction start, which is the
    // left corner in LTR. A dismiss control belongs on the trailing side.
    // The start value has to be auto, not unset: custom properties inherit, so
    // unset here would just pick the 0 that Sonner sets on the html element.
    style: {
      "--toast-close-button-start": "auto",
      "--toast-close-button-end": "0",
      "--toast-close-button-transform": "translate(35%, -35%)",
    } as React.CSSProperties,
    duration: 30_000,
  });
}
