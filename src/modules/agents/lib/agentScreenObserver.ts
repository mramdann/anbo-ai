import {
  type AgentScreenReading,
  type AgentScreenState,
  readAgentScreen,
  type TurnEvidence,
} from "./agentScreenClassifier";
import { codexTurnEvidence } from "./codexTurnEvidence";

export type ObservedAgentKind = "ready" | "working" | "attention" | "finished";

export type ObservedAgentSignal = {
  leafId: number;
  ptyId: number;
  agent: string;
  kind: ObservedAgentKind;
  /** When the turn in progress began; null outside a turn. */
  turnStartedAt: number | null;
  /** How long the turn took, on "finished". */
  durationMs: number | null;
  /** Work the agent left running while it waits, e.g. "1 shell". */
  background: string | null;
};

type Reader = (
  agent: string,
  screen: string,
  evidence: TurnEvidence,
) => AgentScreenReading | AgentScreenState;

export type AgentScreenObserverOptions = {
  read?: Reader;
  evidence?: (leafId: number, agent: string) => TurnEvidence;
  /** How long an idle-looking screen must hold before a turn is over. */
  readyHoldMs?: (agent: string) => number;
  /**
   * How long an unrecognised, motionless screen waits before it counts as
   * waiting; null keeps the last phase instead.
   */
  settleUnknownMs?: number | null;
};

type Turn = { startedAt: number; sawWork: boolean };

type Entry = {
  leafId: number;
  ptyId: number;
  agent: string;
  phase: "working" | "attention" | "ready";
  candidate: AgentScreenState;
  stablePolls: number;
  typed: string;
  pasting: boolean;
  turn: Turn | null;
  readySince: number | null;
  nullSince: number | null;
  workingUntil: number;
  background: string | null;
  screen: string | null;
  changedAt: number;
  /** The last reading and what it read; a screen that did not change reads
   * the same, so it is not run through the patterns again. */
  classified?: {
    screen: string;
    evidence: TurnEvidence;
    reading: AgentScreenReading;
  };
};

const POLL_MS = 200;
const STABLE_POLLS = 2;
const TYPED_LIMIT = 4_096;
/** An unrecognised screen that has not moved for this long is waiting. */
const NULL_SETTLE_MS = 10_000;
/** How long a turn that looks unfinished (see `settling`) is given. */
const SETTLING_HOLD_MS = 30_000;

/**
 * How long a quiet-looking screen must stay quiet before a turn counts as
 * over. Measured on real captures: the longest stretch with no live cue inside
 * a turn was 0.6 s for Claude Code 2.1.284, 0.4 s for Kimi 2.1.1 and OpenCode
 * 1.18, 2.0 s for Codex 0.157 (before its status row first appears) and 2.5 s
 * for Antigravity 1.2.11 (between a command finishing and the model resuming).
 */
const READY_HOLD_MS: Record<string, number> = {
  claude: 1_000,
  codex: 2_500,
  kimi: 1_500,
  antigravity: 3_500,
  agy: 3_500,
  opencode: 1_000,
};
const DEFAULT_READY_HOLD_MS = 1_500;

/**
 * How long a sent message may take to show any work before it stops counting
 * as a turn: a message Kimi folded into its box as a newline, or input a CLI
 * refused, never started one. Antigravity can take four seconds to show its
 * first progress row.
 */
const START_GRACE_MS: Record<string, number> = {
  antigravity: 10_000,
  agy: 10_000,
};
const DEFAULT_START_GRACE_MS = 6_000;

/**
 * How long a tool call Anbo served can keep the agent working.
 *
 * A model routinely pauses several seconds between calls, and some CLIs paint
 * nothing at all in that gap. The browser-turn path keeps a short default: it
 * is deciding when a surface is free, not when to tell the user anything.
 */
export const AGENT_BROWSER_WORKING_MS = 6_000;

const cli = (agent: string) => agent.replace(/^custom:/, "").toLowerCase();

const defaultEvidence = (leafId: number, agent: string): TurnEvidence =>
  cli(agent) === "codex" ? codexTurnEvidence.state(leafId) : null;

const defaultReadyHold = (agent: string) =>
  READY_HOLD_MS[cli(agent)] ?? DEFAULT_READY_HOLD_MS;

const PASTE = /\x1b\[20([01])~/g;
const KEY_SEQUENCE =
  /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[\]P_^][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[^[\]P_^]/g;

type Typing = { typed: string; pasting: boolean };

/**
 * What a keystroke chunk leaves in the composer, and what Enter submitted.
 * Text inside a bracketed paste is content even where it breaks lines, and
 * a paste can span chunks. Every other escape sequence is a key (an arrow, a
 * function key) that types nothing. This only decides whether an Enter sent
 * a message; a miss is caught when the work shows up on screen.
 */
function applyTyping(
  state: Typing,
  data: string,
): Typing & { submitted: string | null } {
  let text = state.typed;
  let pasting = state.pasting;
  let submitted: string | null = null;
  let cursor = 0;
  const type = (chunk: string) => {
    if (pasting) {
      text = (text + chunk.replace(/[\r\n]+/g, " ")).slice(-TYPED_LIMIT);
      return;
    }
    for (const ch of chunk.replace(KEY_SEQUENCE, "")) {
      if (ch === "\r" || ch === "\n") {
        submitted = text.trim();
        text = "";
      } else if (ch === "\x7f" || ch === "\b") text = text.slice(0, -1);
      else if (ch === "\x15" || ch === "\x03" || ch === "\x1b") text = "";
      else if (ch >= " ") text = (text + ch).slice(-TYPED_LIMIT);
    }
  };
  for (const marker of data.matchAll(PASTE)) {
    type(data.slice(cursor, marker.index));
    pasting = marker[1] === "0";
    cursor = marker.index + marker[0].length;
  }
  type(data.slice(cursor));
  return { typed: text, pasting, submitted };
}

/**
 * Follows one agent terminal's turns from its screen and its input.
 *
 * A turn starts when a message is submitted (Enter on typed text that is not a
 * slash command) or when work shows up on screen by itself: a finished
 * background task, a message another agent sent, a queued prompt. It ends when
 * the screen has looked idle, and stood still, for the CLI's measured hold.
 * Only a turn in which work was actually seen is announced as finished; an
 * Enter that never became work goes back to waiting quietly.
 */
export class AgentScreenObserver {
  private readonly entries = new Map<number, Entry>();
  private readonly read: (
    agent: string,
    screen: string,
    evidence: TurnEvidence,
  ) => AgentScreenReading;
  private readonly evidenceFor: (leafId: number, agent: string) => TurnEvidence;
  private readonly readyHold: (agent: string) => number;
  private readonly settleUnknownMs: number | null;

  constructor(options: AgentScreenObserverOptions | Reader = {}) {
    const resolved =
      typeof options === "function" ? { read: options } : options;
    const read = resolved.read ?? readAgentScreen;
    this.read = (agent, screen, evidence) => {
      const value = read(agent, screen, evidence);
      return value !== null && typeof value === "object"
        ? value
        : { state: value, background: null, settling: false };
    };
    this.evidenceFor = resolved.evidence ?? defaultEvidence;
    this.readyHold = resolved.readyHoldMs ?? defaultReadyHold;
    this.settleUnknownMs =
      resolved.settleUnknownMs === undefined
        ? NULL_SETTLE_MS
        : resolved.settleUnknownMs;
  }

  start(
    leafId: number,
    ptyId: number,
    agent: string,
    now = Date.now(),
  ): ObservedAgentSignal {
    const entry: Entry = {
      leafId,
      ptyId,
      agent,
      phase: "working",
      candidate: null,
      stablePolls: 0,
      typed: "",
      pasting: false,
      turn: null,
      readySince: null,
      nullSince: null,
      workingUntil: 0,
      background: null,
      screen: null,
      changedAt: now,
    };
    this.entries.set(leafId, entry);
    return this.signal(entry, "working");
  }

  stop(leafId: number): void {
    this.entries.delete(leafId);
  }

  has(leafId: number): boolean {
    return this.entries.has(leafId);
  }

  /**
   * Keystrokes reach the agent. Only a submitted message starts a turn: a
   * slash command, an empty Enter or a menu key does not, and an answer to a
   * prompt continues the turn that asked it.
   */
  input(
    leafId: number,
    data: string,
    now = Date.now(),
  ): ObservedAgentSignal | null {
    const entry = this.entries.get(leafId);
    if (!entry) return null;
    const { typed, pasting, submitted } = applyTyping(entry, data);
    entry.typed = typed;
    entry.pasting = pasting;
    if (submitted === null) return null;
    if (entry.phase === "attention") {
      return entry.turn ? this.toWorking(entry, now) : null;
    }
    if (!submitted || submitted.startsWith("/")) return null;
    return this.toWorking(entry, now);
  }

  /**
   * A tool call Anbo served for this agent is work, whatever the screen says:
   * several CLIs look idle between calls while a tab still draws the cursor
   * for the call in flight.
   */
  activity(
    leafId: number,
    now = Date.now(),
    holdMs = 1_000,
  ): ObservedAgentSignal | null {
    const entry = this.entries.get(leafId);
    if (!entry) return null;
    entry.turn ??= { startedAt: now, sawWork: true };
    entry.turn.sawWork = true;
    entry.workingUntil = Math.max(entry.workingUntil, now + holdMs);
    return this.toWorking(entry, now);
  }

  poll(
    read: (leafId: number) => string | null,
    now = Date.now(),
  ): ObservedAgentSignal[] {
    const signals: ObservedAgentSignal[] = [];
    for (const entry of this.entries.values()) {
      const screen = read(entry.leafId);
      // No buffer to read says nothing about the agent.
      if (screen === null) continue;
      if (screen !== entry.screen) {
        entry.screen = screen;
        entry.changedAt = now;
      }
      const evidence = this.evidenceFor(entry.leafId, entry.agent);
      const previous = entry.classified;
      const reading =
        previous && previous.screen === screen && previous.evidence === evidence
          ? previous.reading
          : this.read(entry.agent, screen, evidence);
      entry.classified = { screen, evidence, reading };
      const state = reading.state;

      if (reading.background !== entry.background) {
        entry.background = reading.background;
        if (entry.phase === "ready") signals.push(this.signal(entry, "ready"));
      }
      // One sighting of work is enough to know a submitted turn started, and
      // so is a rollout turn recorded since the last input.
      if (entry.turn && (state === "working" || evidence !== null)) {
        entry.turn.sawWork = true;
      }
      if (state === entry.candidate) entry.stablePolls += 1;
      else {
        entry.candidate = state;
        entry.stablePolls = 1;
      }
      entry.readySince = state === "ready" ? (entry.readySince ?? now) : null;
      entry.nullSince = state === null ? (entry.nullSince ?? now) : null;
      if (entry.stablePolls < STABLE_POLLS) continue;

      if (state === "working") {
        entry.turn ??= {
          startedAt: now - (STABLE_POLLS - 1) * POLL_MS,
          sawWork: true,
        };
        if (entry.phase !== "working") {
          entry.phase = "working";
          signals.push(this.signal(entry, "working"));
        }
        continue;
      }
      if (state === "attention") {
        if (entry.phase !== "attention") {
          entry.phase = "attention";
          entry.typed = "";
          signals.push(this.signal(entry, "attention"));
        }
        continue;
      }
      if (state === null) {
        const settle = this.settleUnknownMs;
        if (
          settle !== null &&
          entry.phase !== "ready" &&
          entry.nullSince !== null &&
          now - entry.nullSince >= settle &&
          now - entry.changedAt >= settle
        ) {
          entry.phase = "ready";
          entry.turn = null;
          signals.push(this.signal(entry, "ready"));
        }
        continue;
      }
      const signal = this.settle(entry, reading, evidence, now);
      if (signal) signals.push(signal);
    }
    return signals;
  }

  /** An idle-looking screen: end the turn once it has held long enough. */
  private settle(
    entry: Entry,
    reading: AgentScreenReading,
    evidence: TurnEvidence,
    now: number,
  ): ObservedAgentSignal | null {
    if (entry.phase === "ready" || now < entry.workingUntil) return null;
    const turn = entry.turn;
    if (turn && !turn.sawWork) {
      const grace = START_GRACE_MS[cli(entry.agent)] ?? DEFAULT_START_GRACE_MS;
      if (now - turn.startedAt < grace) return null;
      entry.turn = null;
      entry.phase = "ready";
      return this.signal(entry, "ready");
    }
    if (turn) {
      // Text still streaming in with no progress row (Codex commentary, older
      // Kimi builds) is not an ending: the screen has to look idle and stand
      // still for the whole hold. A rollout that recorded the turn finished
      // needs no hold.
      const hold =
        evidence === "complete"
          ? 0
          : reading.settling
            ? Math.max(this.readyHold(entry.agent), SETTLING_HOLD_MS)
            : this.readyHold(entry.agent);
      const since = entry.readySince ?? now;
      if (now - since < hold || now - entry.changedAt < hold) return null;
      entry.turn = null;
      entry.phase = "ready";
      return {
        ...this.signal(entry, "finished"),
        durationMs: Math.max(0, since - turn.startedAt),
        turnStartedAt: turn.startedAt,
      };
    }
    entry.phase = "ready";
    return this.signal(entry, "ready");
  }

  private toWorking(entry: Entry, now: number): ObservedAgentSignal | null {
    entry.candidate = null;
    entry.stablePolls = 0;
    entry.readySince = null;
    entry.turn ??= { startedAt: now, sawWork: false };
    if (entry.phase === "working") return null;
    entry.phase = "working";
    return this.signal(entry, "working");
  }

  private signal(entry: Entry, kind: ObservedAgentKind): ObservedAgentSignal {
    return {
      leafId: entry.leafId,
      ptyId: entry.ptyId,
      agent: entry.agent,
      kind,
      turnStartedAt: entry.turn?.startedAt ?? null,
      durationMs: null,
      background: entry.background,
    };
  }
}
