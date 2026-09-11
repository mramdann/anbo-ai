import {
  type AgentScreenState,
  classifyAgentScreen,
} from "./agentScreenClassifier";
import { codexTurnEvidence } from "./codexTurnEvidence";

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
  screen: string | null;
};

const STABLE_POLLS = 2;
const MIN_WORKING_MS = 1_000;

/**
 * CLIs whose screen stands still once the turn is really over.
 *
 * Kimi drops its spinner while it streams the answer and keeps the composer
 * mounted, so the screen looks idle for most of a long turn -- a 237-second
 * turn read as finished four times, and each reading told the user their
 * agent was done. For these three a screen that is still being painted is
 * better evidence than a screen that merely looks settled.
 *
 * Measured on this machine before being trusted, because the rule is only
 * safe for a CLI that stops repainting when it has nothing to say: idle Kimi
 * repainted 0 times in 12s, Claude 1, Codex 2, while that long Kimi turn
 * never held still for even one 300ms sample. A CLI that animates while idle
 * must not be added here without the same measurement.
 */
const SCREEN_SETTLES_WHEN_IDLE = new Set(["kimi", "claude", "codex"]);
/**
 * How long a tool call Anbo served can keep the agent working.
 *
 * A model routinely pauses several seconds between calls, and some CLIs paint
 * nothing at all in that gap. Holding a keystroke's one second there announced
 * a finished turn in the middle of one, so the notification path trusts a
 * served call for longer. The browser-turn path keeps the short default: it is
 * deciding when a surface is free, not when to tell the user anything.
 */
export const AGENT_BROWSER_WORKING_MS = 6_000;

export class AgentScreenObserver {
  private readonly entries = new Map<number, Entry>();

  constructor(private readonly classify = classifyAgentScreen) {}

  /**
   * Verified browser work invalidates a previously ready screen.
   *
   * A CLI that keeps its composer mounted through a turn -- Kimi and Claude
   * both do -- looks settled between tool calls, while the tab strip is still
   * drawing a cursor for the call in flight. A call Anbo served itself is
   * better evidence than the screen, so it counts as work, and the signal goes
   * back to the caller to publish.
   */
  activity(
    leafId: number,
    now = Date.now(),
    holdMs = MIN_WORKING_MS,
  ): ObservedAgentSignal | null {
    const signal = this.input(leafId, "\r", now);
    const entry = this.entries.get(leafId);
    if (entry) {
      entry.sawWorkingForTurn = true;
      entry.workingUntil = Math.max(entry.workingUntil, now + holdMs);
    }
    return signal;
  }

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
      screen: null,
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
      const screen = read(entry.leafId);
      const candidate = this.classify(
        entry.agent,
        screen,
        codexTurnEvidence.completed(entry.leafId),
      );
      if (candidate === null) continue;
      const painting = screen !== entry.screen;
      entry.screen = screen;
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
      // A transcript still being written is not a finished turn, however idle
      // the composer below it looks.
      if (
        entry.hasTurn &&
        painting &&
        SCREEN_SETTLES_WHEN_IDLE.has(
          entry.agent.replace(/^custom:/, "").toLowerCase(),
        )
      ) {
        continue;
      }
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
