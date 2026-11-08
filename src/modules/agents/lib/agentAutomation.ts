import type {
  AgentPhase,
  AgentSession,
  AgentStatus,
} from "@/modules/agents/lib/types";
import type { SpaceMeta } from "@/modules/spaces/lib/store";
import type { Tab, TerminalTab } from "@/modules/tabs";
import { labelFor } from "@/modules/tabs/lib/tabLabel";
import type { AgentResumePhase } from "../store/agentResumeStatus";
import {
  type AgentAutomationRequest,
  type AgentAutomationResponse,
  automationError,
  lateRequest,
  paramString,
  pastDeadline,
} from "./agentAutomationProtocol";
import { agentIdFor } from "./agentIdentity";
import { readAgentScreen } from "./agentScreenClassifier";
import { codexTurnEvidence } from "./codexTurnEvidence";
import { displayAgentInstance } from "./format";
import { OutputTracker } from "./outputTracker";
import { collectAgentResumeLeaves } from "./resume";

export type {
  AgentAutomationMethod,
  AgentAutomationRequest,
  AgentAutomationResponse,
} from "./agentAutomationProtocol";
export { AGENT_REQUEST_EVENT } from "./agentAutomationProtocol";
export { agentIdFor } from "./agentIdentity";

const MAX_MESSAGE_CHARS = 8_000;
const MAX_DEDUPLICATION_KEYS = 100;
const MAX_TRACKED_AGENTS = 100;
const SUBMIT_DELAY_MS = 90;
const ANTIGRAVITY_SUBMIT_DELAY_MS = 750;
const INPUT_READY_TIMEOUT_MS = 8_000;
const INPUT_READY_POLL_MS = 25;
const INPUT_CHUNK_CHARS = 256;
const INPUT_ECHO_CHARS = 120;
const INPUT_ECHO_MIN_CHARS = 12;
const INPUT_PROGRESS_READ_MS = 500;
const INPUT_STALL_MS = 30_000;
const INPUT_TYPING_LIMIT_MS = 600_000;
const INPUT_QUIET_LIMIT_MS = 5_000;
const TUI_READY_POLL_MS = 100;
const TUI_READY_STABLE_POLLS = 3;
const SUBMIT_SETTLE_POLLS = 2;

export type AgentDescriptor = {
  agentId: string;
  name: string;
  cli: string;
  /** dormant: restored or paused, not resumed yet (its workspace was not
   *  shown since); resuming: its CLI is starting again on its session. */
  status: AgentStatus | "dormant" | "resuming";
  phase: AgentPhase | "dormant" | "resuming";
  tabId: number;
  leafId: number;
  spaceId: string;
  workspace: string;
  sessionId?: string;
  active: boolean;
  startedAt: number;
  lastActivityAt: number;
};

export type AgentSpawnHandle = {
  agentId: string;
  cli: string;
  tabId: number;
  leafId: number;
  spaceId: string;
  workspace: string;
  activated?: boolean;
};

type ServiceDependencies = {
  getTabs: () => Tab[];
  getSpaces: () => SpaceMeta[];
  getSessions: () => Record<number, AgentSession>;
  getActiveTabId: () => number | null;
  getBuffer: (leafId: number) => string | null;
  /** The terminal's bottom rows as drawn, for reading the agent's state.
   * Falls back to getBuffer. */
  getScreen?: (leafId: number) => string | null;
  prepare: (leafId: number) => boolean;
  /** Why prepare refused a leaf, such as every live terminal buffer in use. */
  unpreparedReason?: (leafId: number) => string;
  write: (leafId: number, data: string) => boolean;
  /** Every input sent to a terminal, Anbo's own writes included. */
  subscribeInput?: (
    listener: (leafId: number, data: string) => void,
  ) => () => void;
  spawn: (
    workspace: ResolvedWorkspace,
    agent: string,
  ) => AgentSpawnHandle | null | Promise<AgentSpawnHandle | null>;
  subscribeSessions: (
    listener: (
      sessions: Record<number, AgentSession>,
      previous: Record<number, AgentSession>,
    ) => void,
  ) => () => void;
  /** Mounts a restored tab that was never shown, so its agent resumes. */
  warm?: (tabId: number) => void;
  /** Which restored agents are being brought back, by leaf. */
  getResumeStatus?: () => Record<number, AgentResumePhase>;
  /** Whether a terminal's shell could not start, and why. */
  getShellState?: (
    leafId: number,
  ) => { spawnFailed?: boolean; spawnError?: string | null } | null;
  /** Closes a tab agent_spawn made whose CLI never started. */
  discardSpawn?: (tabId: number) => void;
  /** Terminals that are the caller's own to close, shared with the terminal
   *  tools: an agent_spawn terminal is, once its CLI has ended. */
  openedTerminals?: Set<string>;
  /** The agent_spawn terminals, with whether their agent has been seen
   *  running; the terminal tools leave one alone until its agent has ended. */
  spawnedTerminals?: Map<string, boolean>;
};

type ResolvedWorkspace = { id: string; root: string };

export type AgentReadResult = {
  output: string;
  cursor: string;
  truncated: boolean;
  reset: boolean;
};

function normalizeRoot(space: SpaceMeta): string | null {
  if (!space.root) return null;
  const root = space.root.replace(/\\/g, "/").replace(/\/+$/, "");
  return space.env.kind === "local" ? root.toLowerCase() : root;
}

export function resolveAgentWorkspace(
  spaces: SpaceMeta[],
  workspace: unknown,
): { ok: true; space: ResolvedWorkspace } | { ok: false; error: string } {
  if (typeof workspace !== "string" || !workspace.trim()) {
    return {
      ok: false,
      error:
        "agent tools require a workspace root or space id; the active UI workspace is never used as a fallback",
    };
  }
  const requested = workspace.trim();
  const byId = spaces.find((space) => space.id === requested && space.root);
  if (byId?.root) return { ok: true, space: { id: byId.id, root: byId.root } };

  const requestedRoot = requested.replace(/\\/g, "/").replace(/\/+$/, "");
  const matches = spaces.filter((space) => {
    const root = normalizeRoot(space);
    if (root === null) return false;
    return space.env.kind === "local"
      ? root === requestedRoot.toLowerCase()
      : root === requestedRoot;
  });
  if (matches.length === 1 && matches[0].root) {
    return {
      ok: true,
      space: { id: matches[0].id, root: matches[0].root },
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      error: "workspace matches multiple Anbo spaces; pass a space id",
    };
  }
  return {
    ok: false,
    error: `workspace is not open in Anbo: ${requested}`,
  };
}

function findResumeSessionId(
  tab: TerminalTab,
  leafId: number,
): string | undefined {
  const visit = (node: TerminalTab["paneTree"]): string | undefined => {
    if (node.kind === "leaf") {
      return node.id === leafId ? node.agentResume?.sessionId : undefined;
    }
    for (const child of node.children) {
      const found = visit(child);
      if (found) return found;
    }
    return undefined;
  };
  return visit(tab.paneTree);
}

function tabHasLeaf(tab: TerminalTab, leafId: number): boolean {
  const visit = (node: TerminalTab["paneTree"]): boolean =>
    node.kind === "leaf"
      ? node.id === leafId
      : node.children.some((child) => visit(child));
  return visit(tab.paneTree);
}

export function collectWorkspaceAgents(
  tabs: Tab[],
  sessions: Record<number, AgentSession>,
  space: ResolvedWorkspace,
  activeTabId: number | null,
  resumeStatus: Record<number, AgentResumePhase> = {},
): AgentDescriptor[] {
  const tabsById = new Map(
    tabs
      .filter(
        (tab): tab is TerminalTab =>
          tab.kind === "terminal" && tab.spaceId === space.id && !tab.private,
      )
      .map((tab) => [tab.id, tab]),
  );
  const live = Object.values(sessions)
    .flatMap((session) => {
      const tab = tabsById.get(session.tabId);
      if (!tab || !tabHasLeaf(tab, session.leafId)) return [];
      return [
        {
          agentId: agentIdFor(session.name, session.agent, session.tabId),
          // The callsign the workspace gave this agent — what a person calls
          // it. `codex:11` says which CLI and which tab, which is an address,
          // not a name.
          name: tab.agent?.name ?? session.name,
          cli: session.agent,
          status: session.status,
          phase:
            session.phase ??
            (session.status === "working" ? "working" : "attention"),
          tabId: session.tabId,
          leafId: session.leafId,
          spaceId: space.id,
          workspace: space.root,
          sessionId: findResumeSessionId(tab, session.leafId),
          active: session.tabId === activeTabId,
          startedAt: session.startedAt,
          lastActivityAt: session.lastActivityAt,
        },
      ];
    })
    .sort((left, right) => left.startedAt - right.startedAt);
  // A restored agent tab of a workspace not shown yet stays cold, and its CLI
  // resumes only when the tab mounts. Unlisted, it looked gone, and an
  // orchestrator that replaces missing agents started a second one beside it.
  const restored = [...tabsById.values()].flatMap((tab) =>
    collectAgentResumeLeaves(tab.paneTree)
      .filter(
        ({ id, resume }) =>
          resume.resumeOnStart &&
          (tab.cold || resumeStatus[id] === "resuming") &&
          !Object.values(sessions).some(
            (session) => session.tabId === tab.id && session.leafId === id,
          ),
      )
      .map(({ id: leafId, resume }): AgentDescriptor => {
        const status = tab.cold ? "dormant" : "resuming";
        // Named as its session will be once it starts, so the id stays put.
        const sessionName = displayAgentInstance(resume.agent, labelFor(tab));
        return {
          agentId: agentIdFor(sessionName, resume.agent, tab.id),
          name: tab.agent?.name ?? sessionName,
          cli: resume.agent,
          status,
          phase: status,
          tabId: tab.id,
          leafId,
          spaceId: space.id,
          workspace: space.root,
          sessionId: resume.sessionId,
          active: tab.id === activeTabId,
          startedAt: 0,
          lastActivityAt: 0,
        };
      }),
  );
  return [...live, ...restored];
}

export function sanitizeAgentMessage(
  value: unknown,
): { ok: true; message: string } | { ok: false; error: string } {
  if (typeof value !== "string") {
    return { ok: false, error: "message must be a string" };
  }
  const message = value.replace(/\s*\r?\n\s*/g, " ").trim();
  if (!message) return { ok: false, error: "message is empty" };
  if (message.length > MAX_MESSAGE_CHARS) {
    return {
      ok: false,
      error: `message exceeds ${MAX_MESSAGE_CHARS} characters`,
    };
  }
  for (let index = 0; index < message.length; index += 1) {
    const code = message.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) {
      return { ok: false, error: "message contains control characters" };
    }
  }
  return { ok: true, message };
}

export function isAgentTuiReady(
  cli: string,
  buffer: string | null,
  leafId?: number,
): boolean {
  const normalizedCli = cli.replace(/^custom:/, "").toLowerCase();
  if (
    normalizedCli !== "codex" &&
    normalizedCli !== "claude" &&
    normalizedCli !== "antigravity" &&
    normalizedCli !== "agy" &&
    normalizedCli !== "opencode" &&
    normalizedCli !== "kimi"
  ) {
    return true;
  }
  // A screen that looks idle while its transcript ends mid-turn is not a
  // prompt to type into, unless the rollout confirms the turn is over.
  const evidence = codexTurnEvidence.state(leafId);
  const screen = readAgentScreen(normalizedCli, buffer, evidence);
  return (
    screen.state === "ready" && (!screen.settling || evidence === "complete")
  );
}

export async function waitForAgentTuiReady(
  getBuffer: () => string | null,
  cli: string,
  timeoutMs: number,
  leafId?: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let stablePolls = 0;
  while (Date.now() < deadline) {
    if (isAgentTuiReady(cli, getBuffer(), leafId)) {
      stablePolls += 1;
      if (stablePolls >= TUI_READY_STABLE_POLLS) return true;
    } else {
      stablePolls = 0;
    }
    await new Promise<void>((resolve) =>
      setTimeout(resolve, TUI_READY_POLL_MS),
    );
  }
  return false;
}

/**
 * CLIs that only accept Enter once they have drawn what was typed.
 *
 * For these a fixed pause before the carriage return is a coin toss: Codex can
 * still be mounting its input, and Kimi folds an Enter that arrives too soon
 * into the box as a newline, leaving the message typed but never sent. Claude
 * does the same while it is busy, as right after a resume when it is still
 * loading its session: the text and an Enter 90 ms later reach it together,
 * the Enter becomes a newline, and every later message joins the same unsent
 * box. All are cheap to wait for -- the echo says when the text landed, and a
 * settled screen says when it is safe to press Enter.
 */
function needsEchoedInput(cli: string): boolean {
  return cli === "codex" || cli === "kimi" || cli === "claude";
}

/**
 * Hold until the screen stops moving, or the deadline passes.
 *
 * An echoed message proves the text arrived, not that the TUI has finished
 * laying it out. A settled buffer is the closest a terminal comes to saying
 * it is done drawing what it was just handed.
 */
async function waitForQuietBuffer(
  getBuffer: (leafId: number) => string | null,
  leafId: number,
  deadline: number,
): Promise<void> {
  let previous = getBuffer(leafId);
  let quiet = 0;
  while (quiet < SUBMIT_SETTLE_POLLS && Date.now() < deadline) {
    await new Promise<void>((resolve) =>
      setTimeout(resolve, INPUT_READY_POLL_MS),
    );
    const current = getBuffer(leafId);
    if (current === previous) {
      quiet += 1;
    } else {
      quiet = 0;
      previous = current;
    }
  }
}

const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The value of `promise` if it settles within `ms`, otherwise null. */
async function settledWithin<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function compactEcho(value: string): string {
  return (
    value
      .replace(
        /\x1b\[[0-9;>?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][AB012]|\x1b[78=>]|\x1bc|\x1b[NOP\]X^_]/g,
        "",
      )
      // A message wider than the prompt wraps inside the input box, and a
      // TUI that draws a border paints its edge at the start of every
      // wrapped row. Those edges land between the echoed fragments, so the
      // needle would never match a long message. Both sides go through this
      // same pass, so dropping the border glyphs keeps the comparison honest
      // even when the message itself contains them.
      .replace(/[\s\u0000-\u001f\u007f\u2500-\u259f]+/g, "")
  );
}

/**
 * How much of `typed` a screen shows, in compacted characters from its start:
 * the longest prefix whose last characters appear on the screen. An echo only
 * grows, so the search starts from `shown`, the count already seen, and a
 * prefix too short to tell apart from other text never counts.
 */
export function echoedLength(
  screen: string,
  typed: string,
  shown: number,
): number {
  const appears = (count: number) =>
    count >= INPUT_ECHO_MIN_CHARS &&
    screen.includes(typed.slice(Math.max(0, count - INPUT_ECHO_CHARS), count));
  let low = Math.min(shown, typed.length);
  let high = typed.length + 1;
  let probe = Math.max(low + 1, INPUT_ECHO_MIN_CHARS);
  for (let step = 2; probe < high; probe = low + step, step *= 2) {
    if (!appears(probe)) {
      high = probe;
      break;
    }
    low = probe;
  }
  while (high - low > 1) {
    const middle = (low + high) >>> 1;
    if (appears(middle)) low = middle;
    else high = middle;
  }
  return low;
}

const TERMINAL_REPORTS =
  /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][^\x1b]*\x1b\\|\x1bO.|\x1b[ -~]/g;

/**
 * Whether terminal input carries something a person typed, not only the
 * focus, mouse and query replies a terminal sends by itself.
 */
export function isTypedInput(data: string): boolean {
  return data.replace(TERMINAL_REPORTS, "").length > 0;
}

/** Why a message stopped short of its Enter. */
type InputStop =
  | "not shown"
  | "stalled"
  | "too long"
  | "write failed"
  | "typed over"
  | "stopped"
  | "dialog"
  | "failed";

type InputOutcome = { ok: true } | { ok: false; reason: InputStop };

type AgentInputDelivery =
  | { state: "submitted" }
  | { state: "cancelled"; reason: InputStop }
  // Still being typed when the answer was due: settles at Enter, or when
  // typing stops.
  | { state: "typing"; finished: Promise<InputOutcome> };

type AgentInputIo = {
  write: (leafId: number, data: string) => boolean;
  getBuffer: (leafId: number) => string | null;
  subscribeInput?: ServiceDependencies["subscribeInput"];
  /** False while the agent shows a question of its own (a folder trust or
   *  approval prompt), where Enter answers it instead of sending. */
  canSubmit?: () => boolean;
};

function startVerifiedTyping(
  io: AgentInputIo,
  leafId: number,
  message: string,
  submitDelayMs: number,
  stopped: () => boolean,
): {
  finished: Promise<InputOutcome>;
  progressing: () => boolean;
  markBackground: () => void;
  cancel: () => void;
} {
  const startedAt = Date.now();
  let shown = 0;
  let shownAt = startedAt;
  let wrote = false;
  let landed = false;
  let cancelled = false;
  let typedOver = false;
  let writing = false;
  // The 30 s no-progress stall only bounds typing we chose to keep going in the
  // background; within the caller's own wait, a message that shows nothing is
  // only given up when that wait ends, never sooner.
  let background = false;
  const unsubscribe =
    io.subscribeInput?.((inputLeafId, data) => {
      if (inputLeafId === leafId && !writing && isTypedInput(data)) {
        typedOver = true;
      }
    }) ?? (() => {});
  const write = (data: string) => {
    writing = true;
    try {
      return io.write(leafId, data);
    } finally {
      writing = false;
    }
  };
  const see = (count: number) => {
    if (count <= shown) return;
    shown = count;
    shownAt = Date.now();
  };
  const interruption = (): InputStop | null => {
    if (stopped()) return "stopped";
    if (typedOver) return "typed over";
    if (landed) return null;
    if (cancelled) return shown === 0 ? "not shown" : "stalled";
    const now = Date.now();
    if (background && now - shownAt >= INPUT_STALL_MS) return "stalled";
    if (now - startedAt >= INPUT_TYPING_LIMIT_MS) return "too long";
    return null;
  };
  const stop = (reason: InputStop): InputOutcome => {
    // Clear the half-typed text, but never over what someone else typed.
    if (wrote && reason !== "typed over" && reason !== "stopped") {
      write("\x03");
    }
    return { ok: false, reason };
  };
  const run = async (): Promise<InputOutcome> => {
    // Keep each paste below TUI collapse thresholds so acknowledgement uses
    // actual echoed text, never an unverified "Pasted text" placeholder.
    for (let offset = 0; offset < message.length; ) {
      const pending = interruption();
      if (pending) return stop(pending);
      let end = Math.min(offset + INPUT_CHUNK_CHARS, message.length);
      const last = message.charCodeAt(end - 1);
      if (end < message.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
      const before = io.getBuffer(leafId);
      if (!write(message.slice(offset, end))) return stop("write failed");
      wrote = true;
      const typed = compactEcho(message.slice(0, end));
      const needle = typed.slice(-INPUT_ECHO_CHARS);
      let measured = before;
      let measuredAt = 0;
      for (;;) {
        await delay(INPUT_READY_POLL_MS);
        const stopping = interruption();
        if (stopping) return stop(stopping);
        const current = io.getBuffer(leafId);
        if (current === null || current === before) continue;
        const screen = compactEcho(current);
        if (needle && screen.includes(needle)) {
          see(typed.length);
          break;
        }
        // A CLI starved of CPU shows a piece a few characters at a time.
        // That growth is what tells it from one that stopped taking input.
        if (
          current !== measured &&
          Date.now() - measuredAt >= INPUT_PROGRESS_READ_MS
        ) {
          measured = current;
          measuredAt = Date.now();
          see(echoedLength(screen, typed, shown));
        }
      }
      offset = end;
    }
    landed = true;
    // Enter is only a send once the paste it follows has landed. A message
    // long enough to be written in more than one piece arrives as a burst,
    // and a carriage return caught inside that burst reads as a newline in
    // the input box rather than a submit -- the message then sits there,
    // typed but never sent. Let the prompt go quiet first, then press Enter
    // on a settled screen.
    await waitForQuietBuffer(
      io.getBuffer,
      leafId,
      Date.now() + INPUT_QUIET_LIMIT_MS,
    );
    await delay(submitDelayMs);
    const stopping = interruption();
    if (stopping) return stop(stopping);
    if (io.canSubmit && !io.canSubmit()) return stop("dialog");
    return write("\r") ? { ok: true } : { ok: false, reason: "write failed" };
  };
  const finished = run()
    .catch((): InputOutcome => ({ ok: false, reason: "failed" }))
    .finally(unsubscribe);
  return {
    finished,
    progressing: () => shown > 0 && Date.now() - shownAt < INPUT_STALL_MS,
    markBackground: () => {
      background = true;
    },
    cancel: () => {
      cancelled = true;
    },
  };
}

/**
 * Type a message into an agent's terminal and press Enter.
 *
 * With `verifyInput` the message goes in pieces, each shown on screen before
 * the next is sent. A CLI starved of CPU takes a long message in a few
 * characters a second (Codex took 40 s for its first 256 at full load), so
 * with `keepTyping` a message whose echo still grows when the answer is due
 * is answered as typing and finished afterwards. It is cleared with Ctrl+C
 * only once its terminal shows no more of it for 30 s, and typing stops,
 * with neither Ctrl+C nor Enter, when someone types into that terminal.
 */
async function deliverAgentMessage(
  io: AgentInputIo,
  leafId: number,
  message: string,
  {
    verifyInput = false,
    submitDelayMs = SUBMIT_DELAY_MS,
    answerWithinMs = INPUT_READY_TIMEOUT_MS,
    keepTyping = false,
    stopped = () => false,
  }: {
    verifyInput?: boolean;
    submitDelayMs?: number;
    answerWithinMs?: number;
    keepTyping?: boolean;
    stopped?: () => boolean;
  } = {},
): Promise<AgentInputDelivery> {
  if (!verifyInput) {
    if (!io.write(leafId, message)) {
      return { state: "cancelled", reason: "write failed" };
    }
    await delay(submitDelayMs);
    if (io.canSubmit && !io.canSubmit()) {
      return { state: "cancelled", reason: "dialog" };
    }
    return io.write(leafId, "\r")
      ? { state: "submitted" }
      : { state: "cancelled", reason: "write failed" };
  }
  const typing = startVerifiedTyping(
    io,
    leafId,
    message,
    submitDelayMs,
    stopped,
  );
  let outcome = await settledWithin(typing.finished, answerWithinMs);
  if (outcome === null) {
    if (keepTyping && typing.progressing()) {
      typing.markBackground();
      return { state: "typing", finished: typing.finished };
    }
    typing.cancel();
    outcome = await typing.finished;
  }
  return outcome.ok
    ? { state: "submitted" }
    : { state: "cancelled", reason: outcome.reason };
}

function inputStopMessage(name: string, reason: InputStop): string {
  switch (reason) {
    case "not shown":
      return `${name} input cancelled: none of the message showed in its terminal in time`;
    case "stalled":
      return `${name} input cancelled: its terminal showed no more of the message for 30 s`;
    case "too long":
      return `${name} input cancelled: typing the message took over 10 minutes`;
    case "write failed":
      return `${name} input cancelled: its terminal closed`;
    case "typed over":
      return `${name} input stopped: someone typed in its terminal, so Anbo typed no more of the message and pressed neither Ctrl+C nor Enter`;
    case "stopped":
      return `${name} input stopped: Anbo's agent service closed`;
    case "dialog":
      return `${name} put up a question of its own (a folder trust or approval prompt) while the message went in, so Anbo did not press Enter, which would have answered it. Read the agent, answer it or ask the user to, then send again`;
    case "failed":
      return `${name} input cancelled`;
  }
}

export async function submitAgentMessage(
  write: (leafId: number, data: string) => boolean,
  getBuffer: (leafId: number) => string | null,
  leafId: number,
  message: string,
  verifyInput = false,
  submitDelayMs = SUBMIT_DELAY_MS,
  inputReadyTimeoutMs = INPUT_READY_TIMEOUT_MS,
): Promise<boolean> {
  const delivery = await deliverAgentMessage(
    { write, getBuffer },
    leafId,
    message,
    { verifyInput, submitDelayMs, answerWithinMs: inputReadyTimeoutMs },
  );
  return delivery.state === "submitted";
}

export class AgentOutputTracker {
  private readonly tracker = new OutputTracker("v1", MAX_TRACKED_AGENTS);

  read(
    agentId: string,
    rawOutput: string,
    cursor: unknown,
    requestedMaxChars: unknown,
  ): AgentReadResult {
    const read = this.tracker.read(
      agentId,
      rawOutput,
      cursor,
      requestedMaxChars,
    );
    return {
      output: read.output,
      cursor: read.cursor,
      truncated: read.hasMore || read.historyTruncated,
      reset: read.reset,
    };
  }

  remove(agentId: string): void {
    this.tracker.remove(agentId);
  }
}

/** The longest a call holds its answer: it ends before the MCP client's own
 *  60 s request limit, as browser and terminal waits do. */
const MAX_HELD_MS = 50_000;
/** How long after a turn ended an agent's screen may still be catching up
 *  with its status, and how long a read waits for it to settle. */
const TURN_END_SETTLE_MS = 1_000;
const SCREEN_SETTLE_POLL_MS = 50;
const SCREEN_SETTLE_MAX_MS = 600;

const sendTimeout = (params: Record<string, unknown>) =>
  typeof params.timeout === "number" && Number.isInteger(params.timeout)
    ? Math.max(100, Math.min(MAX_HELD_MS, params.timeout))
    : 30_000;

const typingResponse = (
  agent: AgentDescriptor,
  message: string,
  queued: boolean,
): AgentAutomationResponse => ({
  result: {
    ok: true,
    agent,
    sent: message,
    queued,
    delivery: "typing",
    note: `${agent.name} is taking this message in slowly, so Anbo is still typing it and presses Enter once all of it shows. Do not send it again; agent_wait with status working tells when ${agent.name} starts on it. If ${agent.name} takes no more of it for 30 s, Anbo clears it instead.`,
  },
});

export function createAgentAutomationService(deps: ServiceDependencies) {
  const output = new AgentOutputTracker();
  // One send at a time per terminal, whichever id or callsign names it, and a
  // message still being typed after its answer keeps the terminal's turn.
  const sendTurns = new Map<number, Promise<void>>();
  const typingInBackground = new Map<number, string>();
  const sendAcknowledgements = new Map<
    string,
    { lastActivityAt: number; buffer: string | null }
  >();
  const messageIds = new Map<string, number>();
  const initialSpawnLeaves = new Set<number>();
  let disposed = false;

  const resolveWorkspace = (
    params: Record<string, unknown>,
  ):
    | { ok: true; workspace: ResolvedWorkspace }
    | { ok: false; response: AgentAutomationResponse } => {
    const workspace = resolveAgentWorkspace(deps.getSpaces(), params.workspace);
    return workspace.ok
      ? { ok: true, workspace: workspace.space }
      : {
          ok: false,
          response: automationError("workspace_not_found", workspace.error),
        };
  };

  const resolveAgents = (
    params: Record<string, unknown>,
  ):
    | { ok: true; workspace: ResolvedWorkspace; agents: AgentDescriptor[] }
    | { ok: false; response: AgentAutomationResponse } => {
    const resolved = resolveWorkspace(params);
    if (!resolved.ok) return resolved;
    const agents = collectWorkspaceAgents(
      deps.getTabs(),
      deps.getSessions(),
      resolved.workspace,
      deps.getActiveTabId(),
      deps.getResumeStatus?.(),
    );
    return { ok: true, workspace: resolved.workspace, agents };
  };

  const resolveTarget = (
    params: Record<string, unknown>,
    { wake = true }: { wake?: boolean } = {},
  ):
    | {
        ok: true;
        workspace: ResolvedWorkspace;
        agent: AgentDescriptor;
        leafId: number;
      }
    | { ok: false; response: AgentAutomationResponse } => {
    const resolved = resolveAgents(params);
    if (!resolved.ok) return resolved;
    const agentId = paramString(params, "agentId");
    if (!agentId) {
      return {
        ok: false,
        response: automationError("invalid_request", "agentId is required"),
      };
    }
    const agent = resolved.agents.find((candidate) => {
      const provisionalId = agentIdFor(
        candidate.cli,
        candidate.cli,
        candidate.tabId,
      );
      const legacyId = `agent:${encodeURIComponent(resolved.workspace.id)}:${candidate.leafId}`;
      return (
        candidate.agentId === agentId ||
        provisionalId === agentId ||
        // An id handed out before the agent got its callsign, or before its
        // tab was renamed, still names the same CLI in the same tab.
        agentId.endsWith(`-${provisionalId}`) ||
        legacyId === agentId ||
        // A callsign addresses the agent as readily as its id does. Names are
        // unique within a workspace, so this cannot become ambiguous.
        candidate.name.toLocaleLowerCase() === agentId.toLocaleLowerCase()
      );
    });
    if (!agent) {
      output.remove(agentId);
      sendAcknowledgements.delete(agentId);
      return {
        ok: false,
        response: automationError(
          "agent_not_found",
          `agent is not available in workspace: ${agentId}`,
        ),
      };
    }
    // A restored agent resumes when a tool acts on it; until its CLI is back
    // there is nothing to read or type into.
    if (wake && (agent.status === "dormant" || agent.status === "resuming")) {
      const resuming = agent.status === "dormant" && deps.warm !== undefined;
      if (resuming) deps.warm?.(agent.tabId);
      return {
        ok: false,
        response: automationError(
          "agent_unavailable",
          `${agent.agentId} ${resuming ? "was restored or paused and had not resumed yet; Anbo is resuming it now" : agent.status === "resuming" ? "is resuming its session" : "was restored or paused and has not resumed yet; showing its tab resumes it"}. Try again once agent_list shows it working or waiting.`,
        ),
      };
    }
    return {
      ok: true,
      workspace: resolved.workspace,
      agent,
      leafId: agent.leafId,
    };
  };

  const waitFor = async (
    params: Record<string, unknown>,
    desired: AgentStatus | "finished" | null,
    timeoutMs: number,
  ): Promise<
    | { matched: true; agent: AgentDescriptor }
    | { matched: false; closed: boolean; agent: AgentDescriptor | null }
  > => {
    // Waiting on a restored agent resumes it, and the wait lasts through its
    // resume rather than reading it as gone.
    const initial = resolveTarget(params, { wake: false });
    if (!initial.ok) {
      return { matched: false, closed: true, agent: null };
    }
    if (initial.agent.status === "dormant") deps.warm?.(initial.agent.tabId);
    const matchesDesired = (agent: AgentDescriptor) =>
      desired === "finished"
        ? agent.phase === "finished"
        : desired !== null &&
          (agent.status === desired ||
            (desired === "waiting" && agent.phase === "attention"));
    if (matchesDesired(initial.agent)) {
      return { matched: true, agent: initial.agent };
    }
    const restoring = (agent: AgentDescriptor) =>
      agent.status === "dormant" || agent.status === "resuming";
    const initialStatus = initial.agent.status;
    const initialPhase = initial.agent.phase;
    const changed = (agent: AgentDescriptor) =>
      restoring(initial.agent)
        ? !restoring(agent)
        : agent.status !== initialStatus || agent.phase !== initialPhase;
    return new Promise((resolve) => {
      let settled = false;
      let unsubscribe = () => {};
      const finish = (
        value:
          | { matched: true; agent: AgentDescriptor }
          | { matched: false; closed: boolean; agent: AgentDescriptor | null },
      ) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        resolve(value);
      };
      const inspect = () => {
        const current = resolveTarget(params, { wake: false });
        if (!current.ok) {
          finish({ matched: false, closed: true, agent: null });
          return;
        }
        if (
          matchesDesired(current.agent) ||
          (!desired && changed(current.agent))
        ) {
          finish({ matched: true, agent: current.agent });
        }
      };
      const timer = setTimeout(() => {
        const current = resolveTarget(params, { wake: false });
        finish({
          matched: false,
          closed: !current.ok,
          agent: current.ok ? current.agent : null,
        });
      }, timeoutMs);
      unsubscribe = deps.subscribeSessions(inspect);
      inspect();
    });
  };

  /** The agent once its CLI shows, why it never will, or null on timeout.
   *  A shell the resource guard refused, or a tab that closed first, left
   *  agent_spawn answering pending for an agent that never appeared. */
  const waitForSpawn = (
    workspace: ResolvedWorkspace,
    handle: AgentSpawnHandle,
    timeoutMs: number,
  ): Promise<AgentDescriptor | { failed: string } | null> =>
    new Promise((resolve) => {
      let settled = false;
      // The UI lists a new tab only once it has drawn it, after the spawn
      // answered; a tab is gone only after it was seen.
      let tabSeen = false;
      let unsubscribe = () => {};
      const finish = (value: AgentDescriptor | { failed: string } | null) => {
        settled = true;
        clearTimeout(timer);
        clearInterval(watch);
        unsubscribe();
        resolve(value);
      };
      const inspect = () => {
        if (settled) return;
        const agent = collectWorkspaceAgents(
          deps.getTabs(),
          deps.getSessions(),
          workspace,
          deps.getActiveTabId(),
        ).find((candidate) => candidate.leafId === handle.leafId);
        if (agent) {
          finish(agent);
          return;
        }
        const shell = deps.getShellState?.(handle.leafId);
        const tabShown = deps.getTabs().some((tab) => tab.id === handle.tabId);
        if (shell?.spawnFailed) {
          finish({
            failed: `the ${handle.cli} terminal's shell could not start: ${shell.spawnError ?? "no reason given"}`,
          });
        } else if (tabSeen && !tabShown) {
          finish({
            failed: `the ${handle.cli} terminal closed before its CLI started`,
          });
        }
        tabSeen ||= tabShown;
      };
      const timer = setTimeout(() => {
        if (!settled) finish(null);
      }, timeoutMs);
      const watch = setInterval(inspect, 250);
      unsubscribe = deps.subscribeSessions(inspect);
      inspect();
    });

  const send = async (
    params: Record<string, unknown>,
    deadline: number | undefined,
    keepTurn: (finished: Promise<void>) => void,
  ): Promise<AgentAutomationResponse> => {
    let target = resolveTarget(params);
    if (!target.ok) return target.response;
    const message = sanitizeAgentMessage(params.message);
    if (!message.ok) return automationError("invalid_request", message.error);
    const sourceAgentId = paramString(params, "sourceAgentId");
    if (sourceAgentId === target.agent.agentId) {
      return automationError(
        "invalid_request",
        "an agent cannot send a message to itself",
      );
    }
    const messageId = paramString(params, "messageId");
    const deduplicationKey = messageId
      ? `${target.agent.agentId}:${messageId}`
      : null;
    if (deduplicationKey && messageIds.has(deduplicationKey)) {
      return automationError(
        "duplicate_message",
        `messageId was already sent: ${messageId}`,
      );
    }

    const waitForReady = params.waitForReady !== false;
    const timeout = sendTimeout(params);
    const normalizedCli = target.agent.cli
      .replace(/^custom:/, "")
      .toLowerCase();
    const isAntigravity =
      normalizedCli === "antigravity" || normalizedCli === "agy";

    const awaitingAcknowledgement = sendAcknowledgements.get(
      target.agent.agentId,
    );
    if (awaitingAcknowledgement) {
      const deadline = Date.now() + timeout;
      let acknowledged = false;
      while (Date.now() < deadline) {
        target = resolveTarget(params);
        if (!target.ok) return target.response;
        if (
          target.agent.lastActivityAt >
            awaitingAcknowledgement.lastActivityAt ||
          deps.getBuffer(target.leafId) !== awaitingAcknowledgement.buffer
        ) {
          acknowledged = true;
          break;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
      }
      if (!acknowledged) {
        return automationError(
          "timeout",
          `timed out waiting for ${target.agent.name} to acknowledge the previous message`,
        );
      }
      sendAcknowledgements.delete(target.agent.agentId);
    }
    const acceptsInitialSpawnMessage = initialSpawnLeaves.has(target.leafId);
    if (
      target.agent.status !== "waiting" &&
      waitForReady &&
      !acceptsInitialSpawnMessage
    ) {
      const waited = await waitFor(params, "waiting", timeout);
      if (!waited.matched) {
        return automationError(
          waited.closed ? "agent_not_found" : "timeout",
          waited.closed
            ? "agent closed while waiting to receive the message"
            : `timed out waiting for ${target.agent.name} to become ready`,
        );
      }
    }

    const current = resolveTarget(params);
    if (!current.ok) return current.response;
    const readPreparedBuffer = (leafId: number) =>
      deps.prepare(leafId) ? deps.getBuffer(leafId) : null;
    const readPreparedScreen = (leafId: number) =>
      deps.prepare(leafId) ? (deps.getScreen ?? deps.getBuffer)(leafId) : null;
    if (!deps.prepare(current.leafId)) {
      const reason = deps.unpreparedReason?.(current.leafId);
      return automationError(
        "agent_not_ready",
        `${current.agent.name} terminal is not attached${reason ? `: ${reason}` : ""}`,
      );
    }
    if (!deps.getSessions()[current.leafId]) {
      return automationError(
        "agent_not_found",
        "agent terminal is no longer available",
      );
    }
    if (
      waitForReady &&
      (acceptsInitialSpawnMessage ||
        needsEchoedInput(normalizedCli) ||
        (!isAntigravity && message.message.length > INPUT_CHUNK_CHARS)) &&
      !(await waitForAgentTuiReady(
        () => readPreparedScreen(current.leafId),
        current.agent.cli,
        timeout,
        current.leafId,
      ))
    ) {
      // Measured: Claude 2.1.303's folder trust prompt, which Enter answers
      // with "No, exit", held a message that read as a plain timeout.
      const asking =
        readAgentScreen(normalizedCli, readPreparedScreen(current.leafId))
          .state === "attention";
      return automationError(
        "agent_not_ready",
        asking
          ? `${current.agent.name} is showing a question of its own, such as a folder trust or approval prompt, so nothing was typed. Read it with agent_read and answer it, or ask the user to, then send again`
          : `${current.agent.name} did not reach a stable input prompt before timeout`,
      );
    }
    // The caller stopped waiting: typing the message now would deliver one it
    // was told timed out.
    if (pastDeadline(deadline)) return lateRequest("send the message");
    if (deduplicationKey) {
      messageIds.set(deduplicationKey, Date.now());
      while (messageIds.size > MAX_DEDUPLICATION_KEYS) {
        const oldest = messageIds.keys().next().value;
        if (oldest === undefined) break;
        messageIds.delete(oldest);
      }
    }
    const delivery = await deliverAgentMessage(
      {
        write: deps.write,
        getBuffer: readPreparedBuffer,
        subscribeInput: deps.subscribeInput,
        // A trust prompt drawn 2 s after Codex started took a message sent
        // at once, and Enter on Claude 2.1.303's trust prompt picks "No, exit".
        canSubmit: () =>
          readAgentScreen(normalizedCli, readPreparedScreen(current.leafId))
            .state !== "attention",
      },
      current.leafId,
      message.message,
      {
        verifyInput:
          !isAntigravity &&
          (acceptsInitialSpawnMessage ||
            needsEchoedInput(normalizedCli) ||
            message.message.length > INPUT_CHUNK_CHARS),
        submitDelayMs: isAntigravity
          ? ANTIGRAVITY_SUBMIT_DELAY_MS
          : SUBMIT_DELAY_MS,
        // The caller hears back by the time it stops waiting; a message its
        // agent is still taking in is finished after that.
        answerWithinMs:
          deadline === undefined
            ? timeout
            : Math.min(timeout, Math.max(0, deadline - Date.now())),
        keepTyping: true,
        stopped: () => disposed,
      },
    );
    if (delivery.state === "cancelled") {
      return automationError(
        "agent_not_ready",
        inputStopMessage(current.agent.name, delivery.reason),
      );
    }
    const delivered = () => {
      initialSpawnLeaves.delete(current.leafId);
      sendAcknowledgements.set(current.agent.agentId, {
        lastActivityAt: current.agent.lastActivityAt,
        buffer: deps.getBuffer(current.leafId),
      });
      while (sendAcknowledgements.size > MAX_TRACKED_AGENTS) {
        const oldest = sendAcknowledgements.keys().next().value;
        if (oldest === undefined) break;
        sendAcknowledgements.delete(oldest);
      }
    };
    const queued = target.agent.status !== "waiting";
    if (delivery.state === "typing") {
      typingInBackground.set(current.leafId, message.message);
      keepTurn(
        delivery.finished.then((outcome) => {
          typingInBackground.delete(current.leafId);
          if (disposed) return;
          if (outcome.ok) delivered();
          else {
            console.warn(
              "[anbo] agent_send:",
              inputStopMessage(current.agent.name, outcome.reason),
            );
          }
        }),
      );
      return typingResponse(current.agent, message.message, queued);
    }
    delivered();
    return {
      result: {
        ok: true,
        agent: current.agent,
        sent: message.message,
        queued,
        delivery: "submitted",
      },
    };
  };

  return {
    async handle(
      request: AgentAutomationRequest,
    ): Promise<AgentAutomationResponse> {
      const params = request.params ?? {};
      if (request.method === "agent_spawn") {
        const resolved = resolveWorkspace(params);
        if (!resolved.ok) return resolved.response;
        const requestedAgent = paramString(params, "agent");
        if (!requestedAgent) {
          return automationError("invalid_request", "agent is required");
        }
        let spawned: AgentSpawnHandle | null;
        try {
          spawned = await deps.spawn(resolved.workspace, requestedAgent);
        } catch (cause) {
          const message = String(cause);
          return automationError(
            message.includes("resource_exhausted:")
              ? "resource_exhausted"
              : "launch_failed",
            message,
          );
        }
        if (!spawned) {
          return automationError(
            "launch_failed",
            `${requestedAgent} is not registered or could not be launched in ${resolved.workspace.root}`,
          );
        }
        initialSpawnLeaves.add(spawned.leafId);
        while (initialSpawnLeaves.size > MAX_TRACKED_AGENTS) {
          const oldest = initialSpawnLeaves.values().next().value;
          if (oldest === undefined) break;
          initialSpawnLeaves.delete(oldest);
        }
        const timeout =
          typeof params.timeout === "number" && Number.isInteger(params.timeout)
            ? Math.max(100, Math.min(MAX_HELD_MS, params.timeout))
            : 15_000;
        const spawnedId = `terminal:${spawned.tabId}:${spawned.leafId}`;
        deps.openedTerminals?.add(spawnedId);
        if (deps.spawnedTerminals) {
          deps.spawnedTerminals.set(spawnedId, false);
          while (deps.spawnedTerminals.size > MAX_TRACKED_AGENTS) {
            const oldest = deps.spawnedTerminals.keys().next().value;
            if (oldest === undefined) break;
            deps.spawnedTerminals.delete(oldest);
          }
        }
        const agent = await waitForSpawn(resolved.workspace, spawned, timeout);
        if (agent && !("failed" in agent)) {
          deps.spawnedTerminals?.set(spawnedId, true);
        }
        if (agent && "failed" in agent) {
          deps.spawnedTerminals?.delete(spawnedId);
          deps.discardSpawn?.(spawned.tabId);
          return automationError(
            agent.failed.includes("resource_exhausted")
              ? "resource_exhausted"
              : "launch_failed",
            `${agent.failed}; nothing was launched${deps.discardSpawn ? " and its tab was closed" : ""}`,
          );
        }
        return {
          result: {
            ok: true,
            pending: agent === null,
            placement: spawned.activated ? "visible-first-tab" : "background",
            agent: agent ?? spawned,
          },
        };
      }
      if (request.method === "agent_list") {
        const resolved = resolveAgents(params);
        if (!resolved.ok) return resolved.response;
        return {
          result: {
            workspace: resolved.workspace.root,
            spaceId: resolved.workspace.id,
            agents: resolved.agents,
          },
        };
      }
      if (request.method === "agent_status") {
        // Only looks: a dormant agent stays dormant.
        const resolved = resolveTarget(params, { wake: false });
        return !resolved.ok
          ? resolved.response
          : { result: { agent: resolved.agent } };
      }
      if (request.method === "agent_read") {
        const resolved = resolveTarget(params);
        if (!resolved.ok) return resolved.response;
        const firstRead = deps.getBuffer(resolved.leafId);
        if (firstRead === null) {
          return automationError(
            "agent_unavailable",
            "agent terminal buffer is not available",
          );
        }
        let raw: string = firstRead;
        // Right after a turn ends the status can be ahead of the screen: the
        // CLI's own end signal comes while its last frame is still on its
        // way. Measured: a read right after agent_wait matched "waiting"
        // returned "Working (3s ...". Such a read waits for the screen to
        // settle.
        if (
          resolved.agent.status === "waiting" &&
          Date.now() - resolved.agent.lastActivityAt < TURN_END_SETTLE_MS
        ) {
          const until = Date.now() + SCREEN_SETTLE_MAX_MS;
          while (Date.now() < until) {
            await new Promise((resolveDelay) =>
              setTimeout(resolveDelay, SCREEN_SETTLE_POLL_MS),
            );
            const next: string = deps.getBuffer(resolved.leafId) ?? raw;
            if (next === raw) break;
            raw = next;
          }
        }
        return {
          result: {
            agent: resolved.agent,
            ...output.read(
              resolved.agent.agentId,
              raw,
              params.cursor,
              params.maxChars,
            ),
          },
        };
      }
      if (request.method === "agent_send") {
        const agentId = paramString(params, "agentId");
        if (!agentId)
          return automationError("invalid_request", "agentId is required");
        const target = resolveTarget(params);
        if (!target.ok) return target.response;
        const { leafId } = target;
        const typing = typingInBackground.get(leafId);
        const message = sanitizeAgentMessage(params.message);
        // The caller was told this message is still being typed; sending it
        // again would deliver it twice.
        if (message.ok && message.message === typing) {
          return typingResponse(
            target.agent,
            typing,
            target.agent.status !== "waiting",
          );
        }
        const previous = sendTurns.get(leafId) ?? Promise.resolve();
        let release = () => {};
        const turn = previous.then(
          () =>
            new Promise<void>((resolve) => {
              release = () => resolve();
            }),
        );
        sendTurns.set(leafId, turn);
        void turn.then(() => {
          if (sendTurns.get(leafId) === turn) sendTurns.delete(leafId);
        });
        const turnWaitMs =
          request.deadline === undefined
            ? sendTimeout(params)
            : Math.max(0, request.deadline - Date.now());
        if ((await settledWithin(previous, turnWaitMs)) === null) {
          // Give the turn on as soon as it comes; this send starts nothing.
          void previous.then(() => release());
          return automationError(
            "timeout",
            `timed out waiting for an earlier message to ${target.agent.name} to be delivered`,
          );
        }
        let typingOn: Promise<void> | undefined;
        try {
          return await send(params, request.deadline, (finished) => {
            typingOn = finished;
          });
        } finally {
          if (typingOn) void typingOn.then(() => release());
          else release();
        }
      }
      if (request.method === "agent_wait") {
        const target = resolveTarget(params, { wake: false });
        if (!target.ok) return target.response;
        const status =
          params.status === "working" ||
          params.status === "waiting" ||
          params.status === "finished"
            ? params.status
            : null;
        const timeout =
          typeof params.timeout === "number" && Number.isInteger(params.timeout)
            ? Math.max(100, Math.min(MAX_HELD_MS, params.timeout))
            : 10_000;
        const waited = await waitFor(params, status, timeout);
        return {
          result: {
            matched: waited.matched,
            timedOut: !waited.matched && !waited.closed,
            closed: !waited.matched && waited.closed,
            agent: waited.agent,
          },
        };
      }
      return automationError(
        "invalid_request",
        `unsupported agent method: ${request.method}`,
      );
    },
    dispose() {
      disposed = true;
      sendTurns.clear();
      typingInBackground.clear();
      sendAcknowledgements.clear();
      messageIds.clear();
      initialSpawnLeaves.clear();
    },
  };
}
