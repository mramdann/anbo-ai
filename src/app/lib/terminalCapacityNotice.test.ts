import type { AgentSession } from "@/modules/agents/lib/types";
import type { SpaceMeta } from "@/modules/spaces/lib/store";
import type { Tab } from "@/modules/tabs";
import type { TerminalCapacityReport } from "@/modules/terminal";
import { describe, expect, it } from "vitest";
import {
  agentIsIdle,
  idleAgentLabel,
  terminalCapacityNotice,
} from "./terminalCapacityNotice";

const space = (id: string, name: string): SpaceMeta =>
  ({ id, name, root: `C:/${name}` }) as unknown as SpaceMeta;

const terminal = (id: number, spaceId: string, leaves: number[]): Tab =>
  ({
    id,
    kind: "terminal",
    spaceId,
    title: `tab ${id}`,
    activeLeafId: leaves[0],
    paneTree:
      leaves.length === 1
        ? { kind: "leaf", id: leaves[0] }
        : {
            kind: "split",
            id: id * 100,
            dir: "row",
            children: leaves.map((leaf) => ({ kind: "leaf", id: leaf })),
          },
  }) as unknown as Tab;

const agent = (
  leafId: number,
  tabId: number,
  name: string,
  cli: string,
  extra: Partial<AgentSession> = {},
): AgentSession => ({
  leafId,
  tabId,
  agent: cli,
  name,
  status: "waiting",
  phase: "finished",
  startedAt: 0,
  lastActivityAt: 0,
  attentionSince: null,
  ...extra,
});

const spaces = [space("oms", "JABAR OMS"), space("mr", "MR OMS")];
const tabs = [
  terminal(1, "oms", [11]),
  terminal(2, "mr", [21]),
  terminal(3, "oms", [31]),
  terminal(4, "oms", [41]),
  terminal(5, "oms", [51]),
  terminal(6, "mr", [61, 62]),
  terminal(7, "oms", [71]),
];
const sessions: Record<number, AgentSession> = {
  1: agent(11, 1, "Alnilam", "codex"),
  2: agent(21, 2, "Leander", "claude", { phase: "working" }),
  3: agent(31, 3, "Orion", "codex", { status: "working", phase: "working" }),
  4: agent(41, 4, "Vega", "claude", { phase: "attention" }),
  5: agent(51, 5, "Rigel", "kimi", { background: "1 shell" }),
  6: agent(61, 6, "Mira", "codex"),
  7: agent(71, 7, "Deneb", "claude"),
};
const report = (
  holders: TerminalCapacityReport["holders"],
  visible = true,
): TerminalCapacityReport => ({ limit: 47, leafId: 99, visible, holders });

describe("the full terminal pool notice", () => {
  it("counts who holds the buffers and offers only agents safe to close", () => {
    const notice = terminalCapacityNotice(
      report([
        { leafId: 11, kind: "agent", visible: false },
        { leafId: 21, kind: "agent", visible: false },
        { leafId: 31, kind: "agent", visible: false },
        { leafId: 41, kind: "agent", visible: false },
        { leafId: 51, kind: "agent", visible: false },
        { leafId: 61, kind: "agent", visible: false },
        { leafId: 71, kind: "agent", visible: true },
        { leafId: 81, kind: "command", visible: false },
        { leafId: 82, kind: "command", visible: false },
        { leafId: 83, kind: "screen", visible: true },
      ]),
      tabs,
      sessions,
      spaces,
    );
    expect(notice.description).toBe(
      "All 47 live buffers are in use: 7 agents (4 waiting), 2 running commands, 1 on screen. Close a tab you no longer need; this one gets the next buffer that frees.",
    );
    // Alnilam and Leander are waiting in tabs of their own. Orion works, Vega
    // asks the user something, Rigel left a shell running, Mira shares her tab
    // with another pane, and Deneb is on screen.
    expect(notice.idleAgents.map((idle) => idle.name)).toEqual([
      "Alnilam",
      "Leander",
    ]);
    expect(notice.idleAgents.map(idleAgentLabel)).toEqual([
      "Alnilam (Codex, JABAR OMS)",
      "Leander (Claude Code, MR OMS)",
    ]);
  });

  it("says when a terminal in the background found the pool full", () => {
    const notice = terminalCapacityNotice(
      report([{ leafId: 81, kind: "command", visible: false }], false),
      tabs,
      sessions,
      spaces,
    );
    expect(notice.description).toBe(
      "All 47 live buffers are in use: 1 running command. A terminal in the background could not get one.",
    );
    expect(notice.idleAgents).toEqual([]);
  });

  it("names an agent without a callsign by its CLI once", () => {
    expect(
      idleAgentLabel({
        tabId: 1,
        leafId: 11,
        name: "Codex",
        cli: "Codex",
        space: "JABAR OMS",
      }),
    ).toBe("Codex (JABAR OMS)");
  });

  it("calls an agent idle only when closing it loses no turn", () => {
    expect(agentIsIdle({ status: "waiting", phase: "finished" })).toBe(true);
    expect(agentIsIdle({ status: "waiting", phase: "working" })).toBe(true);
    expect(agentIsIdle({ status: "working", phase: "working" })).toBe(false);
    expect(agentIsIdle({ status: "waiting", phase: "attention" })).toBe(false);
    expect(
      agentIsIdle({
        status: "waiting",
        phase: "finished",
        background: "1 shell",
      }),
    ).toBe(false);
  });
});
