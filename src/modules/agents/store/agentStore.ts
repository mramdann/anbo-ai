import { create } from "zustand";
import type {
  AgentNotification,
  AgentPhase,
  AgentSession,
  AgentStatus,
  AgentStatusDetail,
  LocalAgentState,
} from "../lib/types";

const MAX_NOTIFICATIONS = 50;

let notifSeq = 0;

type AgentStoreState = {
  sessions: Record<number, AgentSession>;
  localAgent: LocalAgentState;
  notifications: AgentNotification[];
  start: (leafId: number, tabId: number, agent: string, name: string) => void;
  setName: (leafId: number, name: string) => void;
  setStatus: (
    leafId: number,
    status: AgentStatus,
    phase?: AgentPhase,
    detail?: AgentStatusDetail,
  ) => void;
  finish: (leafId: number) => void;
  setLocalAgent: (state: LocalAgentState) => void;
  pushNotification: (n: Omit<AgentNotification, "id" | "at" | "read">) => void;
  markAllRead: () => void;
  clearNotifications: () => void;
};

export const useAgentStore = create<AgentStoreState>((set) => ({
  sessions: {},
  localAgent: null,
  notifications: [],

  start: (leafId, tabId, agent, name) =>
    set((s) => {
      const now = Date.now();
      return {
        sessions: {
          ...s.sessions,
          [leafId]: {
            leafId,
            tabId,
            agent,
            name,
            status: "working",
            phase: "working",
            startedAt: now,
            lastActivityAt: now,
            attentionSince: null,
            turnStartedAt: null,
            background: null,
          },
        },
      };
    }),

  setName: (leafId, name) =>
    set((s) => {
      const previous = s.sessions[leafId];
      if (!previous || previous.name === name) return s;
      return {
        sessions: {
          ...s.sessions,
          [leafId]: { ...previous, name },
        },
      };
    }),

  setStatus: (leafId, status, requestedPhase, detail) =>
    set((s) => {
      const prev = s.sessions[leafId];
      if (!prev) return s;
      const phase =
        requestedPhase ?? (status === "working" ? "working" : "attention");
      const turnStartedAt =
        detail?.turnStartedAt === undefined
          ? (prev.turnStartedAt ?? null)
          : detail.turnStartedAt;
      const background =
        detail?.background === undefined
          ? (prev.background ?? null)
          : detail.background;
      const statusChanged = prev.status !== status || prev.phase !== phase;
      if (
        !statusChanged &&
        turnStartedAt === (prev.turnStartedAt ?? null) &&
        background === (prev.background ?? null)
      ) {
        return s;
      }
      const now = Date.now();
      return {
        sessions: {
          ...s.sessions,
          [leafId]: {
            ...prev,
            status,
            phase,
            turnStartedAt,
            background,
            ...(statusChanged
              ? {
                  lastActivityAt: now,
                  attentionSince: status === "waiting" ? now : null,
                }
              : {}),
          },
        },
      };
    }),

  finish: (leafId) =>
    set((s) => {
      if (!s.sessions[leafId]) return s;
      const next = { ...s.sessions };
      delete next[leafId];
      return { sessions: next };
    }),

  setLocalAgent: (state) =>
    set((s) => {
      const a = s.localAgent;
      if (a === state) return s;
      if (a && state && a.status === state.status && a.agent === state.agent) {
        return s;
      }
      return { localAgent: state };
    }),

  pushNotification: (n) =>
    set((s) => ({
      notifications: [
        { ...n, id: `n${++notifSeq}`, at: Date.now(), read: false },
        ...s.notifications,
      ].slice(0, MAX_NOTIFICATIONS),
    })),

  markAllRead: () =>
    set((s) => {
      if (!s.notifications.some((n) => !n.read)) return s;
      return {
        notifications: s.notifications.map((n) => ({ ...n, read: true })),
      };
    }),

  clearNotifications: () => set({ notifications: [] }),
}));

/** The tab/leaf for the keyboard jump-to-attention shortcut: an agent blocked
 *  on the user first, otherwise the one that most recently started waiting.
 *  Null when none is waiting. */
export function nextAttentionTarget(): {
  tabId: number;
  leafId: number;
} | null {
  const waiting = Object.values(useAgentStore.getState().sessions)
    .filter((s) => s.status === "waiting")
    .sort(
      (a, b) =>
        Number(b.phase === "attention") - Number(a.phase === "attention") ||
        (b.attentionSince ?? 0) - (a.attentionSince ?? 0),
    );
  const t = waiting[0];
  return t ? { tabId: t.tabId, leafId: t.leafId } : null;
}
