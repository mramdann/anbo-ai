import { displayAgent } from "@/modules/agents/lib/format";
import type { AgentSession } from "@/modules/agents/lib/types";
import type { SpaceMeta } from "@/modules/spaces/lib/store";
import type { Tab } from "@/modules/tabs";
import { leafIds, type TerminalCapacityReport } from "@/modules/terminal";

/** An agent waiting for its next task in a tab of its own, which the user may
 *  close to free its live buffer. */
export type IdleAgentTab = {
  tabId: number;
  leafId: number;
  name: string;
  cli: string;
  space: string | null;
};

export type TerminalCapacityNotice = {
  description: string;
  idleAgents: IdleAgentTab[];
};

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

/** Waiting, not asking the user anything, and leaving no background work
 *  behind: closing it loses no turn. */
export function agentIsIdle(
  session: Pick<AgentSession, "status" | "phase" | "background">,
): boolean {
  return (
    session.status === "waiting" &&
    session.phase !== "attention" &&
    !session.background
  );
}

/** What the full pool toast says: who holds the buffers, and which waiting
 *  agents could give theirs back. Agents on screen are left out of the offer;
 *  so is a tab with other panes, which closing would take with it. */
export function terminalCapacityNotice(
  report: TerminalCapacityReport,
  tabs: readonly Tab[],
  sessions: Record<number, AgentSession>,
  spaces: readonly SpaceMeta[],
): TerminalCapacityNotice {
  const byLeaf = new Map(
    Object.values(sessions).map((session) => [session.leafId, session]),
  );
  const count = (kind: TerminalCapacityReport["holders"][number]["kind"]) =>
    report.holders.filter((holder) => holder.kind === kind).length;
  const agents = report.holders.filter((holder) => holder.kind === "agent");
  const waiting = agents.filter((holder) => {
    const session = byLeaf.get(holder.leafId);
    return session !== undefined && agentIsIdle(session);
  });
  const idleAgents = waiting.flatMap((holder): IdleAgentTab[] => {
    if (holder.visible) return [];
    const session = byLeaf.get(holder.leafId);
    const tab = tabs.find((candidate) => candidate.id === session?.tabId);
    if (!session || tab?.kind !== "terminal") return [];
    if (leafIds(tab.paneTree).length !== 1) return [];
    return [
      {
        tabId: tab.id,
        leafId: holder.leafId,
        name: session.name || displayAgent(session.agent),
        cli: displayAgent(session.agent),
        space: spaces.find((space) => space.id === tab.spaceId)?.name ?? null,
      },
    ];
  });
  const parts = [
    agents.length > 0 &&
      `${plural(agents.length, "agent")} (${waiting.length} waiting)`,
    count("command") > 0 && plural(count("command"), "running command"),
    count("screen") > 0 && `${count("screen")} on screen`,
    count("busy") > 0 && `${count("busy")} busy`,
  ].filter(Boolean);
  const held = parts.length > 0 ? `: ${parts.join(", ")}` : "";
  const next = report.visible
    ? "Close a tab you no longer need; this one gets the next buffer that frees."
    : "A terminal in the background could not get one.";
  return {
    description: `All ${report.limit} live buffers are in use${held}. ${next}`,
    idleAgents,
  };
}

/** The confirmation's list: "Alnilam (Codex, JABAR OMS)". */
export function idleAgentLabel(agent: IdleAgentTab): string {
  const where = [agent.cli, agent.space].filter(Boolean).join(", ");
  return agent.name === agent.cli || !where
    ? `${agent.name}${agent.space ? ` (${agent.space})` : ""}`
    : `${agent.name} (${where})`;
}
