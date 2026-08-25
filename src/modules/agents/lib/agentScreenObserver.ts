import {
  classifyAgentScreen,
  type AgentScreenState,
} from "./agentScreenClassifier";

export type ObservedAgentKind = "ready" | "working" | "attention" | "finished";

export type ObservedAgentSignal = {
  leafId: number;
  ptyId: number;
  agent: string;
  kind: ObservedAgentKind;
};

type Entry = {
  leafId: number;
  ptyId: number;
  agent: string;
  phase: AgentScreenState;
  candidate: AgentScreenState;
  stablePolls: number;
  hasTurn: boolean;
  settledOnce: boolean;
  workingUntil: number;
  readySince: number | null;
  sawWorkingForTurn: boolean;
};

const STABLE_POLLS = 2;
const MIN_WORKING_MS = 1_000;

export class AgentScreenObserver {
  private readonly entries = new Map<number, Entry>();

  start(leafId: number, ptyId: number, agent: string): ObservedAgentSignal {
    this.entries.set(leafId, {
      leafId,
      ptyId,
      agent,
      phase: "working",
      candidate: null,
      stablePolls: 0,
      hasTurn: false,
      settledOnce: false,
      workingUntil: 0,
      readySince: null,
      sawWorkingForTurn: false,
    });
    return { leafId, ptyId, agent, kind: "working" };
  }

  stop(leafId: number): void {
    this.entries.delete(leafId);
  }

  has(leafId: number): boolean {
    return this.entries.has(leafId);
  }

  input(
    leafId: number,
    data: string,
    now = Date.now(),
  ): ObservedAgentSignal | null {
    const entry = this.entries.get(leafId);
    if (!entry || !/[\r\n]/.test(data)) return null;
    const wasAttention = entry.phase === "attention";
    entry.hasTurn = true;
    entry.workingUntil = now + MIN_WORKING_MS;
    entry.candidate = null;
    entry.stablePolls = 0;
    entry.readySince = null;
    entry.sawWorkingForTurn = wasAttention;
    if (entry.phase === "working") return null;
    entry.phase = "working";
    return this.signal(entry, "working");
  }

  poll(
    read: (leafId: number) => string | null,
    now = Date.now(),
  ): ObservedAgentSignal[] {
    const signals: ObservedAgentSignal[] = [];
    for (const entry of this.entries.values()) {
      const candidate = classifyAgentScreen(entry.agent, read(entry.leafId));
      if (candidate === null) continue;
      if (entry.candidate === candidate) entry.stablePolls += 1;
      else {
        entry.candidate = candidate;
        entry.stablePolls = 1;
        entry.readySince = null;
      }
      if (entry.stablePolls < STABLE_POLLS) continue;

      if (candidate === "working") {
        entry.readySince = null;
        if (entry.hasTurn) entry.sawWorkingForTurn = true;
        if (entry.phase !== "working") {
          entry.phase = "working";
          signals.push(this.signal(entry, "working"));
        }
        continue;
      }

      if (candidate === "attention") {
        entry.readySince = null;
        if (entry.hasTurn) entry.sawWorkingForTurn = true;
        if (entry.phase !== "attention") {
          entry.phase = "attention";
          signals.push(this.signal(entry, "attention"));
        }
        continue;
      }

      if (candidate !== "ready" || now < entry.workingUntil) continue;
      if (entry.hasTurn && !entry.sawWorkingForTurn) {
        entry.readySince ??= now;
        const delay = entry.agent[0] === "a" ? 1e4 : 1500;
        if (now - entry.readySince < delay) {
          continue;
        }
      }
      if (entry.phase === "ready") continue;
      entry.phase = "ready";
      if (!entry.settledOnce && !entry.hasTurn) {
        entry.settledOnce = true;
        signals.push(this.signal(entry, "ready"));
        continue;
      }
      if (entry.hasTurn) {
        entry.hasTurn = false;
        entry.settledOnce = true;
        entry.readySince = null;
        entry.sawWorkingForTurn = false;
        signals.push(this.signal(entry, "finished"));
      } else {
        signals.push(this.signal(entry, "ready"));
      }
    }
    return signals;
  }

  private signal(entry: Entry, kind: ObservedAgentKind): ObservedAgentSignal {
    return {
      leafId: entry.leafId,
      ptyId: entry.ptyId,
      agent: entry.agent,
      kind,
    };
  }
}
