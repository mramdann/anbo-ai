import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { AgentIcon } from "@/modules/agents/lib/agentIcon";
import type { AgentDescriptor } from "@/modules/agents/lib/agentAutomation";
import {
  type BrowserDesignCapture,
  type BrowserDesignStatus,
  browserDesignCapture,
} from "@/modules/browser/native";
import { requestTerminalAutomation } from "@/modules/terminal/lib/terminalAutomationBridge";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { buildDesignMessage } from "./designMessage";
import { applyBrowserDesignStatus } from "./designState";

const PANEL_TARGET = "anbo-ai-panel";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tabId: number;
  workspaceRoot: string | null;
  status: BrowserDesignStatus;
  /** The callsign of the agent already driving this tab, if any. */
  preferredAgent: string | null;
};

type AgentListResult = { agents?: AgentDescriptor[] };

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function sendToPanel(
  capture: BrowserDesignCapture,
  message: string,
): Promise<void> {
  const [{ useChatStore }, { getOrCreateChat }] = await Promise.all([
    import("@/modules/ai/store/chatStore"),
    import("@/modules/ai/store/chatRuntime"),
  ]);
  const store = useChatStore.getState();
  const sessionId = store.activeSessionId ?? store.newSession();
  const chat = getOrCreateChat(sessionId);
  const parts: (
    | { type: "text"; text: string }
    | { type: "file"; mediaType: string; url: string; filename?: string }
  )[] = [{ type: "text", text: message }];
  if (capture.image) {
    const mediaType = capture.image.startsWith("data:image/jpeg")
      ? "image/jpeg"
      : "image/png";
    parts.push({
      type: "file",
      mediaType,
      url: capture.image,
      filename: capture.imagePath.split(/[\\/]/).pop(),
    });
  }
  useChatStore.getState().focusInput();
  await chat.sendMessage({ role: "user", parts } as Parameters<
    typeof chat.sendMessage
  >[0]);
}

export default function DesignSendDialog({
  open,
  onOpenChange,
  tabId,
  workspaceRoot,
  status,
  preferredAgent,
}: Props) {
  const [agents, setAgents] = useState<AgentDescriptor[]>([]);
  const [loadingAgents, setLoadingAgents] = useState(false);
  const [target, setTarget] = useState<string>("");
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    if (!workspaceRoot) {
      setAgents([]);
      return;
    }
    let cancelled = false;
    setLoadingAgents(true);
    void requestTerminalAutomation("agent_list", { workspace: workspaceRoot })
      .then((response) => {
        if (cancelled) return;
        const list = (response.result as AgentListResult | null)?.agents;
        setAgents(Array.isArray(list) ? list : []);
        if (response.error) setError(response.error.message);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(describeError(caught));
      })
      .finally(() => {
        if (!cancelled) setLoadingAgents(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, workspaceRoot]);

  const defaultTarget = useMemo(() => {
    if (agents.length === 0) return PANEL_TARGET;
    const preferred = preferredAgent?.toLocaleLowerCase();
    const held = preferred
      ? agents.find((agent) => agent.name.toLocaleLowerCase() === preferred)
      : undefined;
    return (held ?? agents[0]).agentId;
  }, [agents, preferredAgent]);
  const selected =
    target &&
    (target === PANEL_TARGET || agents.some((a) => a.agentId === target))
      ? target
      : defaultTarget;

  const send = async () => {
    if (!workspaceRoot) {
      setError(
        "This tab has no workspace, so there is nowhere to save the capture.",
      );
      return;
    }
    setSending(true);
    setError(null);
    try {
      const capture = await browserDesignCapture(
        tabId,
        workspaceRoot,
        selected === PANEL_TARGET,
      );
      applyBrowserDesignStatus({ ...status, dirty: false });
      const text = buildDesignMessage(capture, message);
      if (selected === PANEL_TARGET) {
        await sendToPanel(capture, text);
        toast.success("Design feedback sent to the AI panel", {
          description: capture.imagePath,
        });
      } else {
        const agent = agents.find(
          (candidate) => candidate.agentId === selected,
        );
        const response = await requestTerminalAutomation("agent_send", {
          workspace: workspaceRoot,
          agentId: selected,
          message: text,
        });
        if (response.error) {
          throw new Error(response.error.message);
        }
        toast.success(`Design feedback sent to ${agent?.name ?? "the agent"}`, {
          description: capture.imagePath,
        });
      }
      setMessage("");
      onOpenChange(false);
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !sending && onOpenChange(next)}>
      <DialogContent className="max-w-md gap-0 p-0" showCloseButton={!sending}>
        <DialogHeader className="border-b border-border/60 px-5 py-4 text-left">
          <DialogTitle className="text-sm">Send design feedback</DialogTitle>
          <DialogDescription className="text-xs">
            Anbo captures the page with its {status.marks} numbered mark
            {status.marks === 1 ? "" : "s"}, saves it under the workspace's
            .anbo/artifacts/design folder, and hands the agent the paths plus
            each note.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3 px-5 py-4">
          <div className="flex flex-col gap-1.5 text-xs font-medium">
            <span id="design-send-target">To</span>
            <Select value={selected} onValueChange={setTarget}>
              <SelectTrigger
                size="sm"
                className="w-full text-xs"
                aria-labelledby="design-send-target"
              >
                <SelectValue placeholder="Choose an agent" />
              </SelectTrigger>
              <SelectContent>
                {agents.map((agent) => (
                  <SelectItem
                    key={agent.agentId}
                    value={agent.agentId}
                    className="text-xs"
                  >
                    <AgentIcon agent={agent.cli} size={13} />
                    <span>{agent.name}</span>
                    <span className="text-muted-foreground">
                      {agent.status === "waiting" ? "ready" : "working"}
                    </span>
                  </SelectItem>
                ))}
                <SelectItem value={PANEL_TARGET} className="text-xs">
                  <AgentIcon agent="anbo" size={13} />
                  <span>Anbo AI panel</span>
                </SelectItem>
              </SelectContent>
            </Select>
            {loadingAgents ? (
              <span className="text-[11px] font-normal text-muted-foreground">
                Looking for agents in this workspace...
              </span>
            ) : agents.length === 0 ? (
              <span className="text-[11px] font-normal text-muted-foreground">
                No terminal agent is running in this workspace. Launch one from
                the header, or send it to the AI panel.
              </span>
            ) : null}
          </div>
          <label
            htmlFor="design-send-message"
            className="flex flex-col gap-1.5 text-xs font-medium"
          >
            Message
            <Textarea
              id="design-send-message"
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder="Anything the numbered notes do not already say (optional)"
              className="min-h-20 rounded-md px-2.5 py-2 text-xs"
              maxLength={1_500}
              disabled={sending}
            />
          </label>
          {error ? (
            <p className="rounded-md bg-destructive/10 px-2.5 py-1.5 text-[11px] text-destructive">
              {error}
            </p>
          ) : null}
        </div>
        <DialogFooter className="border-t border-border/60 px-5 py-3">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={sending}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={sending || status.marks === 0 || !workspaceRoot}
            onClick={() => void send()}
          >
            {sending ? "Capturing..." : "Capture and send"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
