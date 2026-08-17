import { labelFor, type Tab } from "@/modules/tabs";
import { hasLeaf, leafIdForPty } from "@/modules/terminal";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef } from "react";
import { displayAgentInstance } from "../lib/format";
import { maybeTriggerManagedReview } from "../lib/review";
import { routeAgentNotification } from "../lib/route";
import type { AgentSession, AgentSignal } from "../lib/types";
import { useWindowFocus } from "../lib/useWindowFocus";
import { useAgentStore } from "../store/agentStore";
import { useManagedAgentsStore } from "../store/managedAgentsStore";

type Activate = (tabId: number, leafId: number) => void;
type Session = (leafId: number, agent: string, sessionId: string) => void;
type Ctx = {
  tabs: Tab[];
  spaces: Array<{ id: string; name: string }>;
  activeId: number;
  focused: boolean;
  onActivate: Activate;
  onSession: Session;
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

function handleSignal(sig: AgentSignal, ctx: Ctx): void {
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
      return;
    }
    case "working":
      store.setStatus(leafId, "working", "working");
      return;
    case "session":
      if (sig.agent && sig.sessionId) {
        ctx.onSession(leafId, sig.agent, sig.sessionId);
      }
      return;
    case "attention": {
      store.setStatus(leafId, "waiting", "attention");
      const session = store.sessions[leafId];
      if (session) route(session, "attention", ctx);
      return;
    }
    case "finished": {
      store.setStatus(leafId, "waiting", "finished");
      const session = store.sessions[leafId];
      if (session) route(session, "finished", ctx);
      maybeTriggerManagedReview(leafId);
      return;
    }
    case "exited":
      store.finish(leafId);
      useManagedAgentsStore.getState().remove(leafId);
      return;
  }
}

export function AgentNotificationsBridge({
  tabs,
  spaces,
  activeId,
  onActivate,
  onSession,
}: {
  tabs: Tab[];
  spaces: Array<{ id: string; name: string }>;
  activeId: number;
  onActivate: Activate;
  onSession: Session;
}) {
  const focused = useWindowFocus();
  const ctxRef = useRef<Ctx>({
    tabs,
    spaces,
    activeId,
    focused,
    onActivate,
    onSession,
  });
  ctxRef.current = {
    tabs,
    spaces,
    activeId,
    focused,
    onActivate,
    onSession,
  };

  useEffect(() => {
    const store = useAgentStore.getState();
    for (const session of Object.values(store.sessions)) {
      const info = tabInfo(tabs, session.leafId);
      if (!info) {
        store.finish(session.leafId);
        continue;
      }
      store.setName(session.leafId, info.name);
    }
  }, [tabs]);

  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    listen<AgentSignal>("anbo:agent-signal", (e) =>
      handleSignal(e.payload, ctxRef.current),
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

  return null;
}
