import { Button } from "@/components/ui/button";
import {
  type BrowserDesignCommand,
  type BrowserDesignStatus,
  type BrowserDesignTool,
  browserDesignCommand,
} from "@/modules/browser/native";
import {
  ArrowUpRight01Icon,
  Cancel01Icon,
  CursorPointer01Icon,
  Delete02Icon,
  HandGrabIcon,
  PencilEdit02Icon,
  SentIcon,
  SquareIcon,
  Undo02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { applyBrowserDesignStatus } from "./designState";

const TOOLS: {
  id: BrowserDesignTool;
  label: string;
  hint: string;
  key: string;
  icon: typeof PencilEdit02Icon;
}[] = [
  {
    id: "box",
    label: "Box",
    hint: "Drag an area, or click an element",
    key: "B",
    icon: SquareIcon,
  },
  {
    id: "pen",
    label: "Pen",
    hint: "Draw freely",
    key: "P",
    icon: PencilEdit02Icon,
  },
  {
    id: "arrow",
    label: "Arrow",
    hint: "Drag toward what you mean",
    key: "A",
    icon: ArrowUpRight01Icon,
  },
  {
    id: "pick",
    label: "Inspect",
    hint: "Click an element to mark it",
    key: "I",
    icon: CursorPointer01Icon,
  },
  {
    id: "hand",
    label: "Hand",
    hint: "Use the page normally",
    key: "V",
    icon: HandGrabIcon,
  },
];

type Props = {
  tabId: number;
  status: BrowserDesignStatus;
  onSend: () => void;
  onExit: () => void;
};

export default function DesignToolbar({
  tabId,
  status,
  onSend,
  onExit,
}: Props) {
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    (command: BrowserDesignCommand) => {
      setBusy(true);
      void browserDesignCommand(tabId, command)
        .then(applyBrowserDesignStatus)
        .catch((error: unknown) => {
          toast.error("Design mode", {
            description: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => setBusy(false));
    },
    [tabId],
  );
  const marks = status.marks;
  return (
    <div
      className="flex h-8 shrink-0 items-center gap-1 border-b border-border/60 bg-card px-1.5"
      role="toolbar"
      aria-label="Design mode"
    >
      <span className="mr-1 flex items-center gap-1.5 pl-1 text-[11px] font-medium text-foreground">
        <span
          aria-hidden
          className="size-1.5 rounded-full bg-primary shadow-[0_0_0_3px] shadow-primary/20"
        />
        Design
      </span>
      <fieldset
        className="flex h-6 min-w-0 items-center overflow-hidden rounded-md border border-border/60"
        aria-label="Tool"
      >
        {TOOLS.map((tool) => {
          const selected = status.tool === tool.id;
          return (
            <button
              key={tool.id}
              type="button"
              aria-pressed={selected}
              disabled={busy}
              onClick={() => run(`tool:${tool.id}`)}
              title={`${tool.label} (${tool.key}): ${tool.hint}`}
              className={`flex h-full items-center gap-1 px-2 text-[11px] outline-none transition-colors focus-visible:bg-accent ${
                selected
                  ? "bg-primary/12 text-primary"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground"
              }`}
            >
              <HugeiconsIcon icon={tool.icon} size={13} strokeWidth={1.75} />
              <span className="hidden md:inline">{tool.label}</span>
            </button>
          );
        })}
      </fieldset>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        disabled={busy}
        onClick={() => run("undo")}
        title="Undo the last change (Ctrl+Z inside the page)"
        className="size-7 shrink-0 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <HugeiconsIcon icon={Undo02Icon} size={14} strokeWidth={1.75} />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        disabled={busy || marks === 0}
        onClick={() => run("clear")}
        title="Remove every mark on this page"
        className="size-7 shrink-0 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <HugeiconsIcon icon={Delete02Icon} size={14} strokeWidth={1.75} />
      </Button>
      <span
        className="ml-1 truncate text-[11px] text-muted-foreground"
        aria-live="polite"
      >
        {status.limit
          ? status.limit
          : marks === 0
            ? "Mark what should change, then send it to an agent."
            : `${marks} mark${marks === 1 ? "" : "s"}${status.dirty ? " · unsent" : ""}`}
      </span>
      <div className="flex-1" />
      <Button
        type="button"
        size="xs"
        disabled={busy || marks === 0}
        onClick={onSend}
        title="Capture the page with its marks and send it to an agent"
        className="h-6 gap-1 rounded-md px-2.5 text-[11px]"
      >
        <HugeiconsIcon icon={SentIcon} size={12} strokeWidth={2} />
        Send to agent
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={onExit}
        title="Leave design mode (Esc inside the page)"
        aria-label="Leave design mode"
        className="size-7 shrink-0 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <HugeiconsIcon icon={Cancel01Icon} size={14} strokeWidth={1.75} />
      </Button>
    </div>
  );
}
