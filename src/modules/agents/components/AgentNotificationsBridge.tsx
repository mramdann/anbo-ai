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
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef } from "react";
import {
  AGENT_BROWSER_WORKING_MS,
  AgentScreenObserver,
  type ObservedAgentSignal,
} from "../lib/agentScreenObserver";
import { prepareAttentionSound } from "../lib/attentionSound";
import { BrowserTurnObserver } from "../lib/browserTurnObserver";
import { codexTurnEvidence } from "../lib/codexTurnEvidence";
import type { CodexTurnWatch } from "../lib/codexTurnWatch";
import { displayAgentInstance } from "../lib/format";
import { maybeTriggerManagedReview } from "../lib/review";
import { routeAgentNotification } from "../lib/route";
import type { AgentSession, AgentSignal } from "../lib/types";
import { useWindowFocus } from "../lib/useWindowFocus";
import { useAgentStore } from "../store/agentStore";
import { useManagedAgentsStore } from "../store/managedAgentsStore";

type Activate = (tabId: number, leafId: number) => void;
type Started = (leafId: number, agent: string, sessionId?: string) => void;
type Settled = (leafId: number, agent: string) => void;
type Exit = (leafId: number) => void;
type Ctx = {
  tabs: Tab[];
  spaces: Array<{ id: string; name: string }>;
  activeId: number;
  focused: boolean;
  onActivate: Activate;
  onStarted: Started;
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
    allowToast: true,
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
  browser: BrowserTurnObserver,
): void {
  const leafId = leafIdForPty(sig.id);
  if (leafId === null) return;
  const store = useAgentStore.getState();

  switch (sig.kind) {
    case "started": {
      const info = tabInfo(ctx.tabs, leafId);
      if (!info) return;
      const agent = sig.agent ?? "agent";
      browser.start(leafId, sig.id, agent);
      store.start(
        leafId,
        info.tabId,
        agent,
        displayAgentInstance(agent, info.name),
      );
      if (!observer.has(leafId)) {
        applyObserved(observer.start(leafId, sig.id, agent), ctx);
      }
      ctx.onStarted(leafId, agent, sig.sessionId);
      return;
    }
    case "exited":
      browser.stop(leafId);
      observer.stop(leafId);
      clearAgentActivity(sig.id);
      store.finish(leafId);
      useManagedAgentsStore.getState().remove(leafId);
      ctx.onExit(leafId);
      return;
    default:
      // Hook/plugin status and session markers are intentionally ignored. The
      // rendered screen and exact native turn evidence replace CLI hooks.
      return;
  }
}

export function AgentNotificationsBridge({
  tabs,
  spaces,
  activeId,
  onActivate,
  onStarted,
  onSettled,
  onExit,
}: {
  tabs: Tab[];
  spaces: Array<{ id: string; name: string }>;
  activeId: number;
  onActivate: Activate;
  onStarted: Started;
  onSettled: Settled;
  onExit: Exit;
}) {
  const focused = useWindowFocus();
  const observerRef = useRef(new AgentScreenObserver());
  const browserRef = useRef(new BrowserTurnObserver());
  const codexRef = useRef<CodexTurnWatch | null>(null);
  const ctxRef = useRef<Ctx>({
    tabs,
    spaces,
    activeId,
    focused,
    onActivate,
    onStarted,
    onSettled,
    onExit,
  });
  ctxRef.current = {
    tabs,
    spaces,
    activeId,
    focused,
    onActivate,
    onStarted,
    onSettled,
    onExit,
  };

  useEffect(() => prepareAttentionSound(), []);

  useEffect(() => {
    let alive = true;
    if (codexRef.current) codexRef.current.sync(tabs);
    else if (
      isTauri() &&
      Object.values(useAgentStore.getState().sessions).some(
        (s) => s.agent === "codex",
      )
    ) {
      void import("../lib/codexTurnWatch").then(({ CodexTurnWatch }) => {
        if (!alive) return;
        codexRef.current ??= new CodexTurnWatch();
        codexRef.current.sync(ctxRef.current.tabs);
      });
    }
    return () => {
      alive = false;
    };
  }, [tabs]);
  useEffect(
    () => () => {
      codexRef.current?.dispose();
      codexTurnEvidence.clear();
    },
    [],
  );

  useEffect(() => {
    browserRef.current.retainTabs(new Set(tabs.map((tab) => tab.id)));
    const store = useAgentStore.getState();
    for (const session of Object.values(store.sessions)) {
      const info = tabInfo(tabs, session.leafId);
      if (!info) {
        codexTurnEvidence.stop(session.leafId);
        browserRef.current.stop(session.leafId);
        observerRef.current.stop(session.leafId);
        store.finish(session.leafId);
        continue;
      }
      store.setName(session.leafId, info.name);
      if (!observerRef.current.has(session.leafId)) {
        const ptyId = ptyIdForLeaf(session.leafId);
        if (ptyId !== null) {
          browserRef.current.start(session.leafId, ptyId, session.agent);
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
    listen<AgentSignal>("anbo:agent-signal", (e) => {
      if (e.payload.kind === "exited") {
        const leaf = leafIdForPty(e.payload.id);
        if (leaf !== null) {
          codexRef.current?.stop(leaf);
          codexTurnEvidence.stop(leaf);
        }
      }
      handleLifecycleSignal(
        e.payload,
        ctxRef.current,
        observerRef.current,
        browserRef.current,
      );
    })
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
    if (!isTauri()) return;
    let alive = true;
    let unlisten: (() => void) | undefined;
    void listen("browser-automation-activity", (event) => {
      const leafId = browserRef.current.receive(event.payload);
      // The same call that moves the cursor on the tab also has to move the
      // agent out of "waiting". Without this the strip showed a live agent
      // while the notification centre called it idle -- and worse, announced
      // the turn finished in the gap between two tool calls.
      if (leafId === null) return;
      const signal = observerRef.current.activity(
        leafId,
        Date.now(),
        AGENT_BROWSER_WORKING_MS,
      );
      if (signal) applyObserved(signal, ctxRef.current);
    })
      .then((remove) => {
        if (alive) unlisten = remove;
        else remove();
      })
      .catch(() => {});
    const unsubscribeInput = subscribeTerminalInput((leafId, data) => {
      const session = useAgentStore.getState().sessions[leafId];
      if (
        session?.agent === "codex" &&
        codexTurnEvidence.input(leafId, data, session.phase === "attention")
      ) {
        // Codex may create its rollout only after the initial discovery timeout.
        ctxRef.current.onSettled(leafId, session.agent);
      }
      browserRef.current.input(leafId, data);
      const signal = observerRef.current.input(leafId, data);
      if (signal) applyObserved(signal, ctxRef.current);
    });
    const timer = window.setInterval(() => {
      const buffers = new Map<number, string | null>();
      const read = (leafId: number) => {
        if (!buffers.has(leafId))
          buffers.set(leafId, readTerminalBuffer(leafId, 160));
        return buffers.get(leafId) ?? null;
      };
      const signals = observerRef.current.poll(read);
      for (const signal of signals) applyObserved(signal, ctxRef.current);
      for (const target of browserRef.current.poll(read)) {
        void invoke("browser_automation_finish_turn", { target }).catch(
          () => {},
        );
      }
    }, 200);
    return () => {
      alive = false;
      unlisten?.();
      unsubscribeInput();
      window.clearInterval(timer);
    };
  }, []);

  return null;
}
