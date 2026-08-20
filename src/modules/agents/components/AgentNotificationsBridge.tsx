import { labelFor, type Tab } from "@/modules/tabs";
import {
  clearAgentActivity,
  hasLeaf,
  leafIdForPty,
  ptyIdForLeaf,
  readTerminalBuffer,
  setAgentActivity,
  subscribeTerminalInput,
} from "@/modules/terminal";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef } from "react";
import { displayAgentInstance } from "../lib/format";
import {
  AgentScreenObserver,
  type ObservedAgentSignal,
} from "../lib/agentScreenObserver";
import { maybeTriggerManagedReview } from "../lib/review";
import { routeAgentNotification } from "../lib/route";
import type { AgentSession, AgentSignal } from "../lib/types";
import { useWindowFocus } from "../lib/useWindowFocus";
import { useAgentStore } from "../store/agentStore";
import { useManagedAgentsStore } from "../store/managedAgentsStore";

type Activate = (tabId: number, leafId: number) => void;
type Settled = (leafId: number, agent: string) => void;
type Exit = (leafId: number) => void;
type Ctx = {
  tabs: Tab[];
  spaces: Array<{ id: string; name: string }>;
  activeId: number;
  focused: boolean;
  onActivate: Activate;
  onSettled: Settled;
  onExit: Exit;
};

function tabInfo(
  tabs: Tab[],
  leafId: number,
): {
  tabId: number;
  name: string;
  spaceId: string;
} | null {
  for (const t of tabs) {
    if (t.kind === "terminal" && hasLeaf(t.paneTree, leafId)) {
      return {
        tabId: t.id,
        name: labelFor(t),
        spaceId: t.spaceId,
      };
    }
  }
  return null;
}

function route(
  session: AgentSession,
  kind: "attention" | "finished",
  ctx: Ctx,
): void {
  const info = tabInfo(ctx.tabs, session.leafId);
  const name = displayAgentInstance(session.agent, info?.name ?? session.name);
  const workspace = info
    ? ctx.spaces.find((space) => space.id === info.spaceId)?.name
    : undefined;
  const tabId = info?.tabId ?? session.tabId;
  const heading =
    kind === "attention" ? `${name} needs your input` : `${name} finished`;

  routeAgentNotification({
    source: "terminal",
    agent: session.agent,
    name,
    kind,
    title: heading,
    workspace,
    focused: ctx.focused,
    visible: ctx.activeId === tabId,
    // Stop fires every turn, so finished only updates the bell; attention toasts.
    allowToast: kind === "attention",
    tabId,
    leafId: session.leafId,
    onActivate: () => ctx.onActivate(tabId, session.leafId),
  });
}

function applyObserved(sig: ObservedAgentSignal, ctx: Ctx): void {
  const store = useAgentStore.getState();
  switch (sig.kind) {
    case "working":
      store.setStatus(sig.leafId, "working", "working");
      setAgentActivity(sig.ptyId, sig.agent, "working");
      return;
    case "ready":
      store.setStatus(sig.leafId, "waiting", "finished");
      setAgentActivity(sig.ptyId, sig.agent, "idle");
      return;
    case "attention": {
      store.setStatus(sig.leafId, "waiting", "attention");
      setAgentActivity(sig.ptyId, sig.agent, "attention");
      const session = store.sessions[sig.leafId];
      if (session) route(session, "attention", ctx);
      return;
    }
    case "finished": {
      store.setStatus(sig.leafId, "waiting", "finished");
      setAgentActivity(sig.ptyId, sig.agent, "finished");
      const session = store.sessions[sig.leafId];
      if (session) route(session, "finished", ctx);
      maybeTriggerManagedReview(sig.leafId);
      ctx.onSettled(sig.leafId, sig.agent);
    }
  }
}

function handleLifecycleSignal(
  sig: AgentSignal,
  ctx: Ctx,
  observer: AgentScreenObserver,
): void {
  const leafId = leafIdForPty(sig.id);
  if (leafId === null) return;
  const store = useAgentStore.getState();

  switch (sig.kind) {
    case "started": {
      const info = tabInfo(ctx.tabs, leafId);
      if (!info) return;
      const agent = sig.agent ?? "agent";
      store.start(
        leafId,
        info.tabId,
        agent,
        displayAgentInstance(agent, info.name),
      );
      if (!observer.has(leafId)) {
        applyObserved(observer.start(leafId, sig.id, agent), ctx);
      }
      return;
    }
    case "exited":
      observer.stop(leafId);
      clearAgentActivity(sig.id);
      store.finish(leafId);
      useManagedAgentsStore.getState().remove(leafId);
      ctx.onExit(leafId);
      return;
    default:
      // Hook/plugin status and session markers are intentionally ignored. The
      // rendered terminal screen is the only activity source after cutover.
      return;
  }
}

export function AgentNotificationsBridge({
  tabs,
  spaces,
  activeId,
  onActivate,
  onSettled,
  onExit,
}: {
  tabs: Tab[];
  spaces: Array<{ id: string; name: string }>;
  activeId: number;
  onActivate: Activate;
  onSettled: Settled;
  onExit: Exit;
}) {
  const focused = useWindowFocus();
  const observerRef = useRef(new AgentScreenObserver());
  const ctxRef = useRef<Ctx>({
    tabs,
    spaces,
    activeId,
    focused,
    onActivate,
    onSettled,
    onExit,
  });
  ctxRef.current = {
    tabs,
    spaces,
    activeId,
    focused,
    onActivate,
    onSettled,
    onExit,
  };

  useEffect(() => {
    const store = useAgentStore.getState();
    for (const session of Object.values(store.sessions)) {
      const info = tabInfo(tabs, session.leafId);
      if (!info) {
        observerRef.current.stop(session.leafId);
        store.finish(session.leafId);
        continue;
      }
      store.setName(session.leafId, info.name);
      if (!observerRef.current.has(session.leafId)) {
        const ptyId = ptyIdForLeaf(session.leafId);
        if (ptyId !== null) {
          applyObserved(
            observerRef.current.start(session.leafId, ptyId, session.agent),
            ctxRef.current,
          );
        }
      }
    }
  }, [tabs]);

  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    listen<AgentSignal>("anbo:agent-signal", (e) =>
      handleLifecycleSignal(e.payload, ctxRef.current, observerRef.current),
    )
      .then((u) => {
        if (alive) unlisten = u;
        else u();
      })
      .catch(() => {});
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    const unsubscribeInput = subscribeTerminalInput((leafId, data) => {
      const signal = observerRef.current.input(leafId, data);
      if (signal) applyObserved(signal, ctxRef.current);
    });
    const timer = window.setInterval(() => {
      const signals = observerRef.current.poll((leafId) =>
        readTerminalBuffer(leafId, 160),
      );
      for (const signal of signals) applyObserved(signal, ctxRef.current);
    }, 200);
    return () => {
      unsubscribeInput();
      window.clearInterval(timer);
    };
  }, []);

  return null;
}
