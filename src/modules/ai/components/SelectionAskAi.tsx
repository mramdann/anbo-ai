import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { fmtShortcut, MOD_KEY } from "@/lib/platform";
import type { PresenceState } from "@/lib/usePresence";
import { useEffect, useRef } from "react";

export type SelectionAskAiProps = {
  state: PresenceState;
  x: number;
  y: number;
  onAsk: () => void;
  onDismiss: () => void;
};

const ESTIMATED_WIDTH = 118;
const OFFSET = 32;

export function SelectionAskAi({
  state,
  x,
  y,
  onAsk,
  onDismiss,
}: SelectionAskAiProps) {
  const pos = useRef({ top: 0, left: 0 });
  const open = state === "open";

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onDismiss]);

  if (open) {
    pos.current = {
      top: Math.max(8, y - OFFSET),
      left: Math.max(
        8,
        Math.min(x - ESTIMATED_WIDTH / 2, window.innerWidth - ESTIMATED_WIDTH - 8),
      ),
    };
  }

  return (
    <div
      data-selection-ask-ai
      data-state={state}
      style={{ top: pos.current.top, left: pos.current.left }}
      className="fixed z-50 whitespace-nowrap duration-150 ease-out data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:slide-in-from-bottom-1 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=closed]:slide-out-to-bottom-1"
    >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onAsk();
        }}
        className="inline-flex h-7 items-center justify-between gap-2 whitespace-nowrap rounded-md border border-border/60 bg-card/95 px-2.5 text-xs shadow-lg backdrop-blur-md hover:border-border hover:bg-accent"
      >
        <span className="whitespace-nowrap font-medium">Ask Anbo</span>
        <KbdGroup className="shrink-0">
          <Kbd className="h-4 min-w-4 whitespace-nowrap px-1 text-[10px]">
            {fmtShortcut(MOD_KEY, "L")}
          </Kbd>
        </KbdGroup>
      </button>
    </div>
  );
}
