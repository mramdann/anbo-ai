import { useAgentStore } from "@/modules/agents/store/agentStore";
import { useSpaces } from "@/modules/spaces";
import type { Tab } from "@/modules/tabs";
import { setTerminalCapacityHandler } from "@/modules/terminal";
import { type RefObject, useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  agentIsIdle,
  type IdleAgentTab,
  terminalCapacityNotice,
} from "../lib/terminalCapacityNotice";

type Params = {
  tabsRef: RefObject<Tab[]>;
  disposeTab: (id: number) => void;
};

/**
 * The toast for a full terminal pool: it counts who holds the live buffers
 * and, when agents wait in tabs of their own, offers to close them after a
 * confirmation. Nothing here runs until the pool is full.
 */
export function useTerminalCapacityNotice({ tabsRef, disposeTab }: Params) {
  const [pending, setPending] = useState<IdleAgentTab[] | null>(null);

  useEffect(() => {
    setTerminalCapacityHandler((report) => {
      const notice = terminalCapacityNotice(
        report,
        tabsRef.current ?? [],
        useAgentStore.getState().sessions,
        useSpaces.getState().spaces,
      );
      const idle = notice.idleAgents;
      toast.error("Terminal capacity reached", {
        id: "terminal-capacity",
        description: notice.description,
        ...(idle.length > 0 && {
          duration: 12_000,
          action: {
            label: `Close ${idle.length} waiting agent${idle.length === 1 ? "" : "s"}`,
            onClick: () => setPending(idle),
          },
        }),
      });
    });
    return () => setTerminalCapacityHandler(null);
  }, [tabsRef]);

  const confirmIdleAgentClose = useCallback(() => {
    if (!pending) return;
    const sessions = Object.values(useAgentStore.getState().sessions);
    // One may have started a turn while the dialog was open.
    for (const agent of pending) {
      const session = sessions.find((s) => s.leafId === agent.leafId);
      const tab = (tabsRef.current ?? []).find((t) => t.id === agent.tabId);
      if (!session || !tab || !agentIsIdle(session)) continue;
      disposeTab(agent.tabId);
    }
    // A tab still waiting on screen gets the first buffer that frees.
    setPending(null);
  }, [pending, tabsRef, disposeTab]);

  const cancelIdleAgentClose = useCallback(() => setPending(null), []);

  return {
    pendingIdleAgents: pending,
    confirmIdleAgentClose,
    cancelIdleAgentClose,
  };
}
