import { formatAgentDuration } from "./format";
import type { AgentNotification, AgentSession, LocalAgentState } from "./types";

/**
 * What the bell's badge counts: an agent blocked at a prompt, and a finished
 * turn not yet seen. An agent idling at its prompt asks for nothing; counting
 * it kept the badge lit for every open agent and counted a fresh finish twice
 * (once as a waiting agent, once as an unread alert). The in-app agent only
 * waits when a tool needs approval.
 */
export function bellBadgeCount(
  sessions: readonly AgentSession[],
  localAgent: LocalAgentState,
  notifications: readonly AgentNotification[],
): number {
  const needsYou =
    sessions.filter((session) => session.phase === "attention").length +
    (localAgent?.status === "waiting" ? 1 : 0);
  const unreadDone = notifications.filter(
    (notification) => notification.kind !== "attention" && !notification.read,
  ).length;
  return needsYou + unreadDone;
}

/** The status word on an active-agent row, with how long a turn has run. */
export function agentStatusLabel(
  session: Pick<AgentSession, "status" | "phase" | "background">,
  workingForMs: number | null,
): string {
  if (session.phase === "attention") return "needs you";
  if (session.status === "waiting") {
    return session.background ? `waiting · ${session.background}` : "waiting";
  }
  return workingForMs === null
    ? "working"
    : `working · ${formatAgentDuration(workingForMs)}`;
}

/** The kind word on a retained alert, with how long a finished turn took. */
export function notificationLabel(
  notification: Pick<AgentNotification, "kind" | "durationMs">,
): string {
  const label =
    notification.kind === "attention"
      ? "needs input"
      : notification.kind === "finished"
        ? "finished"
        : "failed";
  const took = notification.durationMs ?? 0;
  return notification.kind === "finished" && took >= 1_000
    ? `${label} · ${formatAgentDuration(took)}`
    : label;
}
