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
    action: { label: "Open", onClick: onActivate },
    duration: 30_000,
  });
}
