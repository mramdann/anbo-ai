import { resolveAgentWorkspace } from "@/modules/agents/lib/agentAutomation";
import { agentIdFor } from "@/modules/agents/lib/agentIdentity";
import {
  type AgentAutomationResponse,
  automationError,
  lateRequest,
  paramString,
  pastDeadline,
  type TerminalAutomationMethod,
} from "@/modules/agents/lib/agentAutomationProtocol";
import type { AgentSession } from "@/modules/agents/lib/types";
import {
  clampMaxChars,
  keptOutput,
  OutputTracker,
} from "@/modules/agents/lib/outputTracker";
import type { SpaceMeta } from "@/modules/spaces/lib/store";
import type { Tab, TerminalTab } from "@/modules/tabs";
import { FIRST_PROMPT_WAIT_MS } from "@/modules/terminal/lib/firstPrompt";
import { findLeafCwd, leafIds } from "@/modules/terminal/lib/panes";
import type { TerminalSessionState } from "@/modules/terminal/lib/useTerminalSession";

const MAX_INPUT_CHARS = 8_000;
const MAX_TITLE_CHARS = 64;
const MAX_TRACKED_TERMINALS = 100;
const MAX_EXECUTIONS = 100;
const WAIT_POLL_MS = 75;
const DISPATCH_DELAY_MS = 200;
const INITIAL_PROMPT_SYNC_POLL_MS = 25;
/** How long terminal_insert looks for its text on screen. On a busy machine
 *  the echo came after 500 ms, and the tool said the text was not shown. */
const INPUT_VISIBILITY_TIMEOUT_MS = 1_500;
const INPUT_VISIBILITY_POLL_MS = 25;
/** The longest a foreground-process check may take. One that never answered
 *  held a command queued for good, and every later one read busy. */
const FOREGROUND_CHECK_TIMEOUT_MS = 3_000;
/** How long after a command's end a process in its terminal can be the shell's
 *  own: drawing its prompt, Git Bash forks for the directory and the branch,
 *  which takes a moment on Windows, and the next command read as refused with
 *  "it runs bash.exe". */
const PROMPT_HELPERS_MS = 1_000;
const PROMPT_HELPERS_POLL_MS = 50;
/** A line the shell has not started as a command this long after its Enter,
 *  while it shows a continuation prompt, is an unfinished command. */
const UNFINISHED_COMMAND_MS = 1_500;
/** The longest terminal_wait holds its answer, as browser waits do: it ends
 *  before the MCP client's own 60 s request limit. */
const MAX_WAIT_MS = 50_000;
/** How often a wait reads along with a running command, so a burst of
 *  output keeps overlapping what was read before it. */
const OUTPUT_FOLLOW_MS = 250;
/** Below this, an answer cut short keeps only the output's latest part. */
const SPLIT_OUTPUT_MIN_CHARS = 400;
/** A command that ends this soon after Anbo's Ctrl+C reads as interrupted. In
 *  Dev the commands a Ctrl+C stopped ended within half a second of it; a
 *  program that catches Ctrl+C runs on and ends whenever it would have. */
const INTERRUPT_STOP_MS = 3_000;
/** How long after its Ctrl+C an execution may go without its shell marking
 *  the end, once none of its programs is left, before Anbo ends it unconfirmed.
 *  A terminal whose output stopped reaching Anbo held its execution, and so
 *  the terminal, for good. */
const INTERRUPT_UNCONFIRMED_MS = 5_000;
/** How long none of its programs must have been left before Anbo ends it so.
 *  A ping that ran on had just ended, before its shell drew the prompt that
 *  marks the end, when one look found it gone: 8 of 10 such runs in a new
 *  shell read interrupted, with no exit code (round 81). */
const UNCONFIRMED_EMPTY_MS = 2_000;
/** How long an interrupt waits for a command the shell has not started yet,
 *  while no program runs in the terminal either. A Ctrl+C sent before
 *  PowerShell took the line waited in its input behind the command's Enter and
 *  reached the prompt only once the command had run to its end: 5 of about
 *  1,000 interrupts sent 2.5 s after the command went out, on a busy Dev, every
 *  one to a command not yet running (round 78). */
const INTERRUPT_START_WAIT_MS = 3_000;
const INTERRUPT_START_POLL_MS = 50;
/** How often an interrupted execution waiting for that looks for programs. */
const FOREGROUND_RECHECK_MS = 1_000;
/** How long after its Ctrl+C an interrupt looks for cmd's batch question,
 *  which showed 52 ms after it in Dev. */
const BATCH_QUESTION_WATCH_MS = 2_000;
const BATCH_QUESTION_POLL_MS = 25;
/** One answer per question: the typed letter takes a moment to echo. */
const BATCH_ANSWER_GAP_MS = 1_000;
/** How long after its Ctrl+C an interrupt looks for a program that started
 *  too late to get it. A Ctrl+C that reached the console after PowerShell
 *  took the line, but before the program it starts had joined the console,
 *  stopped PowerShell alone, which then waited for the program to run to its
 *  end: 10 of 20 pings in a new shell (round 81), and on a busy Dev pings
 *  that started up to 6.5 s after the Ctrl+C (round 79, R79-1). */
const LATE_PROGRAM_WATCH_MS = 10_000;
const LATE_PROGRAM_POLL_MS = 250;
/** A program that started this long before the Ctrl+C, or later, may not
 *  have joined the console in time. At 200 ms, a ping made 0.3 s before the
 *  Ctrl+C on a busy machine got none and ran all 20 replies, while its shell
 *  took the Ctrl+C: 1 of 8,263 pings under load (round 92, R86-1). The cost: a
 *  program that stops in its own time, interrupted in its first second, gets a
 *  second Ctrl+C. */
const LATE_PROGRAM_MARGIN_MS = 1_000;
/** How long a late program runs before its Ctrl+C goes out: one sent the
 *  moment it starts can come before it has joined the console too. */
const LATE_PROGRAM_AGE_MS = 300;
/** How long a Ctrl+C has to stop a program before another goes out. A ping
 *  that got it was gone within 0.2 s. */
const INTERRUPT_RESEND_GAP_MS = 1_000;
const MAX_INTERRUPT_RESENDS = 2;
/** After the watch, how long and how often it goes on looking, only to note
 *  what runs, for the line an interrupted command that ran on logs. A ping
 *  ran 20 of 20 after a Ctrl+C with no second one sent, and nothing told
 *  whether it started too late or the Ctrl+C missed it running (R86-1). */
const LATE_PROGRAM_TRACE_MS = 60_000;
const LATE_PROGRAM_TRACE_POLL_MS = 2_000;
/** How long a terminal this service opened may take to enter the tab list.
 *  A terminal_execute in the same script as its terminal_open found no
 *  terminal one time in three in Dev. */
const OPENED_TERMINAL_SETTLE_MS = 1_000;
const OPENED_TERMINAL_POLL_MS = 25;

export type SharedTerminalDescriptor = {
  terminalId: string;
  title: string;
  tabId: number;
  leafId: number;
  spaceId: string;
  workspace: string;
  cwd: string;
  active: boolean;
  /** dormant: a restored tab whose shell starts when a tool first uses it.
   *  failed: its shell could not start; terminal_execute starts it again. */
  status: "idle" | "busy" | "starting" | "exited" | "dormant" | "failed";
  shell: string;
  columns?: number;
  rows?: number;
};

/** A program running in a terminal's shell, with when it started (ms since
 *  1970) where the platform tells. */
export type ShellProcess = { pid: number; name: string; startedAt?: number };

export type TerminalAutomationDependencies = {
  getTabs: () => Tab[];
  getSpaces: () => SpaceMeta[];
  getSessions: () => Record<number, AgentSession>;
  getActiveTabId: () => number | null;
  getBuffer: (leafId: number) => string | null;
  /** The bottom of the terminal as the rows it draws, wrapped rows unjoined. */
  getScreen?: (leafId: number) => string | null;
  /** The terminal's whole scrollback, for finding a command's start once a
   *  burst of output scrolled it out of getBuffer's lines. */
  getHistory?: (leafId: number) => string | null;
  /** A number that changes whenever the terminal's grid is resized, which
   *  re-wraps the rows getBuffer reads; undefined without a live grid. */
  getLayout?: (leafId: number) => number | undefined;
  getSessionState: (leafId: number) => TerminalSessionState | null;
  hasForegroundProcess: (leafId: number) => Promise<boolean>;
  /** The programs the shell runs, to name what holds a busy terminal. */
  foregroundProcesses?: (leafId: number) => Promise<ShellProcess[]>;
  prepare: (leafId: number) => boolean;
  /** Why prepare refused a leaf, for the agent whose command it holds back. */
  unpreparedReason: (leafId: number) => string;
  open: (
    workspace: { id: string; root: string },
    title: string,
  ) => { tabId: number; leafId: number; activated?: boolean } | null;
  /** Closes a terminal tab; `endingAgent` lets it end the agent CLI in it,
   *  which only terminal_close with force asks, for an agent_spawn one. */
  close: (tabId: number, leafId: number, endingAgent?: boolean) => boolean;
  write: (leafId: number, data: string) => boolean;
  /** Mounts a restored tab that was never shown, so its shell starts. */
  warm?: (tabId: number) => void;
  /** Starts again a shell that could not start. */
  retryStart?: (leafId: number) => boolean;
  /** A line for Anbo's own log, which prod keeps too, unlike the console. */
  logWarning: (message: string) => void;
  /** The caller's own terminals, shared with the agent tools, which add the
   *  terminal of an agent they spawned. */
  openedTerminals?: Set<string>;
  /** Terminals agent_spawn made, with whether their agent has been seen
   *  running: the terminal tools leave one alone until its agent has ended. */
  spawnedTerminals?: Map<string, boolean>;
  initialPromptSyncTimeoutMs?: number;
};

type TerminalReadSnapshot = {
  output: string;
  cursor: string;
  truncated: boolean;
  hasMore: boolean;
  historyTruncated: boolean;
  reset: boolean;
  replayed: boolean;
};

/** Everything one execution printed so far, before an answer cuts it. */
type ExecutionOutput = {
  text: string;
  cursorAt: (index: number) => string;
  reset: boolean;
  replayed: boolean;
  historyTruncated: boolean;
  /** False when the text came from the scrollback, outside what cursors
   *  page through. */
  pageable?: boolean;
};

type ExecutionPhase =
  | "queued"
  | "dispatched"
  | "running"
  | "completed"
  | "interrupted";

type CompletionReason = "exited" | "interrupted" | "closed" | "dispatch_failed";

/** What the looks after an execution's first Ctrl+C saw. */
type LateWatchTrace = {
  firstCtrlCAt: number;
  looks: number;
  slowestLookMs: number;
  /** By pid: the name, and when it started from the first Ctrl+C (null where
   *  the platform does not tell). */
  programs: Map<number, { name: string; fromCtrlCMs: number | null }>;
};

type ExecutionState = {
  executionId: string;
  terminalId: string;
  workspace: string;
  terminal: SharedTerminalDescriptor;
  baselineGeneration: number;
  cursor: string;
  startedAt: number;
  usesOsc: boolean;
  initialFingerprint: string;
  inputText: string;
  sawBusy: boolean;
  phase: ExecutionPhase;
  interruptRequested: boolean;
  /** When Anbo last sent this execution's command a Ctrl+C, or answered
   *  cmd's batch question in its place. */
  interruptSentAt?: number;
  /** Ended after a Ctrl+C without its shell marking the end. */
  endUnconfirmed?: boolean;
  foregroundCheckedAt?: number;
  /** When a look after the Ctrl+C last found one of the command's programs. */
  programSeenAt?: number;
  /** Since when the looks after the Ctrl+C have found none of them left. */
  noProgramSince?: number;
  /** How many more Ctrl+Cs Anbo sent, each for a program that started too
   *  late for the one before, and the programs the first of them was for. */
  interruptResent?: number;
  resentTo?: string[];
  /** The programs those were for, by pid and start: each gets one at most. */
  resentPrograms?: Set<string>;
  /** The latest watch for such a program: an interrupt sent again starts a
   *  new one, and the older one stops. */
  lateProgramWatch?: number;
  lateWatchTrace?: LateWatchTrace;
  answeredBatchQuestion?: boolean;
  waitCount: number;
  dispatchedAt?: number;
  runningAt?: number;
  /** When the shell marked the command's end, or when Anbo saw it end. */
  completedAt?: number;
  /** completedAt came from the shell's own end mark. */
  endMarked?: boolean;
  completionReason?: CompletionReason;
  /** Why a dispatch_failed command was never sent. */
  dispatchError?: string;
  exitCode: number | null;
  /** The whole output once the command ended; each wait cuts its own answer
   *  from it. A copy cut to the first wait's maxChars gave every later wait
   *  the same cut. */
  finalOutput?: ExecutionOutput;
};

function bufferFingerprint(value: string): string {
  let hash = 2_166_136_261;
  const start = Math.max(0, value.length - 4_096);
  for (let index = start; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `${value.length}:${hash >>> 0}`;
}

function shellSupportsOsc(shell: string | null | undefined): boolean {
  return /^(?:pwsh|powershell|bash|zsh|fish)$/.test(shell ?? "");
}

/** A shell with Anbo's integration that has not ended its first prompt. A
 *  Ctrl+C now can end Windows PowerShell or stop its integration script, and
 *  typing lands ahead of the prompt. The session stops waiting for the mark
 *  a minute after the shell started (firstPrompt.ts). */
function shellStarting(state: TerminalSessionState): boolean {
  return state.awaitingFirstPrompt === true && shellSupportsOsc(state.shell);
}

/** The yes letter of the question cmd asks when a Ctrl+C reaches a batch
 *  file ("^CTerminate batch job (Y/N)?"), if the screen ends with it. Windows
 *  words it in its own language, so the shape is matched, not the words. */
export function batchJobQuestion(screen: string): string | null {
  return /\^C[^\r\n]*\((\p{L})\/\p{L}\)[ \t]*\?\s*$/u.exec(screen)?.[1] ?? null;
}

/** Whether the screen ends with the prompt a shell shows while it waits for
 *  the rest of an unfinished command: PowerShell's ">>", bash's ">", zsh's
 *  "quote>" and the like. */
export function continuationPrompt(screen: string): boolean {
  const lines = screen.trimEnd().split("\n");
  return /^(?:>>|[a-z]*>)$/.test((lines[lines.length - 1] ?? "").trim());
}

const UNFINISHED_COMMAND =
  "The shell read the command as unfinished (an open quote or bracket, or a line ending in a pipe or backtick) and waited for more lines, so it did not run. Anbo cancelled it with Ctrl+C; correct the command and run it again.";

/** At most `maxChars` of an execution's output: all of it when it fits;
 *  otherwise its start and its latest part around a line saying how much was
 *  left out. A wait on a long job showed the same start every time, and a
 *  repainted one only its end. */
export function clipExecutionOutput(
  text: string,
  maxChars: number,
): { output: string; omittedFrom: number; omittedChars: number } {
  if (text.length <= maxChars) {
    return { output: text, omittedFrom: text.length, omittedChars: 0 };
  }
  if (maxChars < SPLIT_OUTPUT_MIN_CHARS) {
    return {
      output: text.slice(text.length - maxChars),
      omittedFrom: 0,
      omittedChars: text.length - maxChars,
    };
  }
  const marker = (chars: number) =>
    `\n[... ${chars} characters left out; terminal_read with omittedCursor reads them ...]\n`;
  const headLength = Math.floor(maxChars / 4);
  const tailLength = maxChars - headLength - marker(text.length).length;
  // Cut at line ends where one is near, so neither part starts mid-line.
  const headBreak = text.lastIndexOf("\n", headLength);
  const headEnd = headBreak > headLength / 2 ? headBreak + 1 : headLength;
  let tailStart = text.length - tailLength;
  const tailBreak = text.indexOf("\n", tailStart);
  if (tailBreak !== -1 && tailBreak < tailStart + tailLength / 4) {
    tailStart = tailBreak + 1;
  }
  const omittedChars = tailStart - headEnd;
  return {
    output: `${text.slice(0, headEnd)}${marker(omittedChars)}${text.slice(tailStart)}`,
    omittedFrom: headEnd,
    omittedChars,
  };
}

/** Whether the screen ends with a pager waiting for a key: less's ":" or
 *  "(END)", more's "-- More --". A pager ignores Ctrl+C and waits for q, which
 *  no tool could send: a git diff in an agent's terminal held it for good. */
export function pagerOnScreen(screen: string): boolean {
  const lines = screen.trimEnd().split("\n");
  const last = (lines[lines.length - 1] ?? "").trim();
  return /^(?::|.*\(END\)|--\s?More\s?(?:\(\d+%\))?\s?--)$/.test(last);
}

function firstPromptMissing(timeoutMs: number): string {
  return `The shell did not mark its first prompt within ${timeoutMs / 1000} s, so nothing was sent: Anbo follows a command by the prompt marks of its shell integration. Run the command again; a profile that replaces the prompt can keep the mark from appearing.`;
}

/** Why a shell cannot take a queued command now, or null when it can. The
 *  foreground check runs last: it asks the PTY. */
async function busyShellReason(
  state: TerminalSessionState,
  hasForegroundProcess: () => Promise<boolean>,
): Promise<string | null> {
  if (state.shellExited) return "The shell exited before the command was sent.";
  if (!state.ready)
    return "The shell had not finished starting, so nothing was sent. Run the command again once terminal_list shows the terminal idle.";
  if (state.inputPending)
    return "The prompt held input nobody had submitted, so nothing was sent. Submit or clear it (terminal_interrupt without an executionId clears it), then run the command again.";
  if (state.commandRunning || state.blockMode !== "prompt")
    return "Another command started in the terminal first, so nothing was sent. Wait for it to finish, or interrupt it, then run the command again.";
  if (await hasForegroundProcess())
    return "A program was running in the foreground of the terminal, so nothing was sent. Wait for it to end, or interrupt it, then run the command again.";
  return null;
}

class TerminalOutputTracker {
  private readonly tracker = new OutputTracker("t1", MAX_TRACKED_TERMINALS);

  /** `layoutOf` changes whenever a terminal's grid re-wraps its rows. */
  constructor(
    private readonly layoutOf: (id: string) => number | undefined = () =>
      undefined,
  ) {}

  checkpoint(id: string, rawOutput: string): string {
    return this.tracker.checkpoint(id, rawOutput, this.layoutOf(id));
  }

  read(
    id: string,
    rawOutput: string,
    cursor: unknown,
    requestedMaxChars: unknown,
  ): TerminalReadSnapshot {
    const read = this.tracker.read(
      id,
      rawOutput,
      cursor,
      requestedMaxChars,
      this.layoutOf(id),
    );
    return {
      output: read.output,
      cursor: read.cursor,
      truncated: read.hasMore,
      hasMore: read.hasMore,
      historyTruncated: read.historyTruncated,
      reset: read.reset,
      replayed: read.reset && cursor !== undefined,
    };
  }

  /** One execution's output so far: everything after its cursor. When the
   *  cursor no longer applies (a repaint, or more output at once than the
   *  lines read each time), the output starts where the command's own text
   *  shows last, on screen or in the scrollback, or is all that is kept. */
  execution(
    id: string,
    rawOutput: string,
    cursor: string,
    command: string,
    ended: boolean,
    history?: () => string | null,
  ): ExecutionOutput {
    const span = this.tracker.span(id, rawOutput, cursor, this.layoutOf(id));
    if (span.dropped) {
      return {
        text: span.text,
        cursorAt: span.cursorAt,
        reset: true,
        replayed: false,
        historyTruncated: true,
      };
    }
    // An ended command's output starts with its own echo. Without it the
    // cursor was lost: the same 400 lines scrolling by again read as no
    // change, and a second run of a long command answered with nothing.
    const lost =
      span.reset || (ended && command !== "" && !span.text.includes(command));
    if (!lost) {
      // A repaint can put blank rows and the prompt's width in spaces ahead of
      // the echo: a mission's first wait began with four empty lines and 43
      // spaces (round 64, R64-6). The output starts at the echo then.
      const echo = command ? span.text.indexOf(command) : -1;
      const lead =
        echo > 0 && span.text.slice(0, echo).trim() === "" ? echo : 0;
      return {
        text: span.text.slice(lead),
        cursorAt: (index) => span.cursorAt(lead + index),
        reset: false,
        replayed: false,
        historyTruncated: false,
      };
    }
    const onScreen =
      span.reset && command ? span.text.lastIndexOf(command) : -1;
    if (onScreen >= 0) {
      return {
        text: span.text.slice(onScreen),
        cursorAt: (index) => span.cursorAt(onScreen + index),
        reset: true,
        replayed: false,
        historyTruncated: false,
      };
    }
    const deep = command ? keptOutput(history?.() ?? "") : "";
    const inHistory = command ? deep.lastIndexOf(command) : -1;
    if (inHistory >= 0) {
      const end = span.cursorAt(span.text.length);
      return {
        text: deep.slice(inHistory),
        cursorAt: () => end,
        reset: true,
        replayed: false,
        historyTruncated: false,
        pageable: false,
      };
    }
    return {
      text: span.text,
      cursorAt: span.cursorAt,
      reset: true,
      replayed: true,
      historyTruncated: false,
    };
  }

  remove(id: string): void {
    this.tracker.remove(id);
  }
}

function terminalId(tabId: number, leafId: number): string {
  return `terminal:${tabId}:${leafId}`;
}

function isAgentLeaf(
  sessions: Record<number, AgentSession>,
  tabId: number,
  leafId: number,
): boolean {
  return agentSessionAt(sessions, tabId, leafId) !== undefined;
}

function agentSessionAt(
  sessions: Record<number, AgentSession>,
  tabId: number,
  leafId: number,
): AgentSession | undefined {
  return Object.values(sessions).find(
    (session) => session.tabId === tabId && session.leafId === leafId,
  );
}

/** A terminal the terminal tools leave to the agent in it. */
type AgentTerminal = {
  tabId: number;
  leafId: number;
  /** Null while the CLI agent_spawn started has not come up yet. */
  agentId: string | null;
  /** agent_spawn started it. */
  spawned: boolean;
};

/** Why a terminal tool does not reach an agent's terminal, and what does. */
function agentTerminalMessage(id: string, agent: AgentTerminal): string {
  const who = agent.agentId
    ? `agent ${agent.agentId}`
    : "an agent that is still starting";
  return agent.spawned
    ? `${id} is the terminal of ${who}, which agent_spawn started, so terminal tools leave it to that agent while it runs: agent_read and agent_send reach it, agent_send '/exit' or '/quit' ends it at its prompt, and terminal_close with force: true closes it, ending the agent and its shell`
    : `${id} is the terminal of ${who}, so terminal tools leave it alone: agent_read and agent_send reach it`;
}

function baseStatus(
  state: TerminalSessionState | null,
): SharedTerminalDescriptor["status"] {
  if (state?.spawnFailed) return "failed";
  if (!state?.ready) return state?.shellExited ? "exited" : "starting";
  if (state.shellExited) return "exited";
  if (shellStarting(state)) return "starting";
  return state.commandRunning || state.blockMode !== "prompt" ? "busy" : "idle";
}

/** Why a terminal takes no input now, and what happens next. */
function unreadyMessage(
  id: string,
  status: SharedTerminalDescriptor["status"],
  started: boolean,
  spawnError?: string | null,
): string {
  if (status === "dormant") {
    return started
      ? `${id} had not started (its tab was restored, or its workspace paused, and not shown since); Anbo is starting it now. Try again once terminal_list shows it idle.`
      : `${id} has not started (its tab was restored, or its workspace paused, and not shown since), so it has no output yet; terminal_execute or showing its tab starts it.`;
  }
  if (status === "failed") {
    const reason = spawnError ? `: ${spawnError}` : "";
    return started
      ? `${id}'s shell could not start${reason}. Anbo is starting it again; try again once terminal_list shows it idle.`
      : `${id}'s shell could not start${reason}.`;
  }
  return `${id} is ${status}; wait for an idle shell prompt`;
}

/** What an execution says when its shell ended or never started. */
function shellGoneReason(state: TerminalSessionState | null): string {
  return state?.spawnFailed
    ? `The shell could not start: ${state.spawnError ?? "no reason given"}`
    : "The shell exited before the command was sent.";
}

export async function collectSharedTerminals(
  deps: TerminalAutomationDependencies,
  space: { id: string; root: string },
  verifyForeground = true,
  /** Terminals kept even after an agent CLI started in one made its tab an
   *  agent tab: the ones terminal_open made, which stay theirs to close. */
  opened?: ReadonlySet<string>,
  /** Terminals agent_spawn made: their agent's while it starts or runs. */
  spawned?: Map<string, boolean>,
): Promise<SharedTerminalDescriptor[]> {
  const sessions = deps.getSessions();
  const activeTabId = deps.getActiveTabId();
  const candidates = deps
    .getTabs()
    .filter(
      (tab): tab is TerminalTab =>
        tab.kind === "terminal" && tab.spaceId === space.id && !tab.private,
    )
    .flatMap((tab) =>
      leafIds(tab.paneTree).flatMap((leafId) => {
        const id = terminalId(tab.id, leafId);
        const live = isAgentLeaf(sessions, tab.id, leafId);
        // An agent_spawn terminal is its agent's until that agent ends: listed
        // while it ran, another agent could read it, interrupt it or type
        // into its CLI (round 64, R64-2). agent_* tools reach it meanwhile.
        if (spawned?.has(id)) {
          if (live) spawned.set(id, true);
          if (live || !spawned.get(id)) return [];
        }
        if ((tab.agent || live) && !opened?.has(id)) {
          return [];
        }
        const state = deps.getSessionState(leafId);
        return [
          {
            terminalId: id,
            title: tab.title,
            tabId: tab.id,
            leafId,
            spaceId: space.id,
            workspace: space.root,
            cwd: findLeafCwd(tab.paneTree, leafId) ?? tab.cwd ?? space.root,
            active: tab.id === activeTabId && tab.activeLeafId === leafId,
            // A restored tab is not mounted until shown or used: it has no
            // session at all, and read "starting" for hours.
            status: !state && tab.cold ? "dormant" : baseStatus(state),
            shell: state?.shell ?? "unknown",
            columns: state?.columns,
            rows: state?.rows,
          } satisfies SharedTerminalDescriptor,
        ];
      }),
    );

  if (!verifyForeground) return candidates;
  return Promise.all(
    candidates.map(async (terminal) => {
      if (terminal.status !== "idle") return terminal;
      return (await deps.hasForegroundProcess(terminal.leafId))
        ? { ...terminal, status: "busy" as const }
        : terminal;
    }),
  );
}

export function sanitizeTerminalInput(
  value: unknown,
): { ok: true; text: string } | { ok: false; error: string } {
  if (typeof value !== "string") {
    return { ok: false, error: "text must be a string" };
  }
  if (!value.trim()) return { ok: false, error: "text is empty" };
  if (value.length > MAX_INPUT_CHARS) {
    return {
      ok: false,
      error: `text exceeds ${MAX_INPUT_CHARS} characters`,
    };
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) {
      return {
        ok: false,
        error: "text must be one line and cannot contain control characters",
      };
    }
  }
  return { ok: true, text: value };
}

export function sanitizeTerminalTitle(
  value: unknown,
): { ok: true; title: string } | { ok: false; error: string } {
  if (typeof value !== "string") {
    return { ok: false, error: "title must be a string" };
  }
  const title = value.trim();
  if (!title) return { ok: false, error: "title is required" };
  if (title.length > MAX_TITLE_CHARS) {
    return {
      ok: false,
      error: `title exceeds ${MAX_TITLE_CHARS} characters`,
    };
  }
  for (let index = 0; index < title.length; index += 1) {
    const code = title.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) {
      return {
        ok: false,
        error: "title must be one line and cannot contain control characters",
      };
    }
  }
  return { ok: true, title };
}

/** One line on an interrupted command that ran on: when it ended, and each
 *  program the late-program watch saw with its start from the first Ctrl+C. */
function describeRanOn(execution: ExecutionState): string {
  const trace = execution.lateWatchTrace;
  const sentAt = trace?.firstCtrlCAt ?? execution.interruptSentAt ?? 0;
  const endedAt = execution.completedAt ?? Date.now();
  const seconds = (ms: number) => `${(Math.abs(ms) / 1000).toFixed(1)} s`;
  const programs = [...(trace?.programs ?? [])].map(([pid, program]) =>
    program.fromCtrlCMs === null
      ? `${program.name} (pid ${pid}, start not known)`
      : `${program.name} (pid ${pid}) started ${seconds(program.fromCtrlCMs)} ${program.fromCtrlCMs < 0 ? "before" : "after"} it`,
  );
  return [
    `${execution.terminalId} ${execution.executionId} ended ${seconds(endedAt - sentAt)} after the first Ctrl+C${execution.endUnconfirmed ? " (end not marked)" : ""}`,
    `exit code ${execution.exitCode ?? "none"}`,
    `command sent ${seconds(sentAt - (execution.dispatchedAt ?? sentAt))} before it`,
    `Ctrl+C sent again ${execution.interruptResent ?? 0} times`,
    `${trace?.looks ?? 0} looks, slowest ${trace?.slowestLookMs ?? 0} ms`,
    `programs seen: ${programs.join(", ") || "none"}`,
  ].join("; ");
}

/** `ask`, answered with `fallback` when it fails or takes longer than `ms`. */
function answerWithin<T>(
  ask: (leafId: number) => Promise<T>,
  ms: number,
  fallback: T,
): (leafId: number) => Promise<T> {
  return (leafId) =>
    new Promise<T>((resolveAnswer) => {
      const timer = setTimeout(() => resolveAnswer(fallback), ms);
      ask(leafId).then(
        (value) => {
          clearTimeout(timer);
          resolveAnswer(value);
        },
        () => {
          clearTimeout(timer);
          resolveAnswer(fallback);
        },
      );
    });
}

export function createTerminalAutomationService(
  dependencies: TerminalAutomationDependencies,
) {
  // A failed check already reads as no foreground process (useTerminalSession);
  // one that never answers now does too, instead of holding the tool forever.
  const deps: TerminalAutomationDependencies = {
    ...dependencies,
    hasForegroundProcess: answerWithin(
      dependencies.hasForegroundProcess,
      FOREGROUND_CHECK_TIMEOUT_MS,
      false,
    ),
    foregroundProcesses: dependencies.foregroundProcesses
      ? answerWithin(
          dependencies.foregroundProcesses,
          FOREGROUND_CHECK_TIMEOUT_MS,
          [],
        )
      : undefined,
  };
  const output = new TerminalOutputTracker((id) => {
    const leafId = Number(id.split(":")[2]);
    return Number.isSafeInteger(leafId) ? deps.getLayout?.(leafId) : undefined;
  });
  const executions = new Map<string, ExecutionState>();
  const openedTerminals = deps.openedTerminals ?? new Set<string>();
  let executionSequence = 0;

  /** What a busy terminal runs, for the agent told it is busy. */
  const runningIn = async (leafId: number): Promise<string> => {
    const programs = (await deps.foregroundProcesses?.(leafId)) ?? [];
    if (programs.length === 0) return "";
    const named = programs
      .slice(0, 3)
      .map((program) => `${program.name} (pid ${program.pid})`)
      .join(", ");
    return `; it runs ${named}${programs.length > 3 ? " and more" : ""}`;
  };

  const rememberExecution = (execution: ExecutionState) => {
    executions.set(execution.executionId, execution);
    while (executions.size > MAX_EXECUTIONS) {
      const oldest = executions.keys().next().value;
      if (oldest === undefined) break;
      executions.delete(oldest);
    }
  };

  /** `endedAt` is when the shell marked the end, when it did. */
  const finishExecution = (
    execution: ExecutionState,
    reason: CompletionReason,
    exitCode: number | null,
    endedAt?: number,
  ) => {
    if (execution.phase === "completed" || execution.phase === "interrupted") {
      return;
    }
    execution.phase = reason === "interrupted" ? "interrupted" : "completed";
    execution.completionReason = reason;
    execution.exitCode = exitCode;
    execution.completedAt = endedAt ?? Date.now();
    execution.endMarked = endedAt !== undefined;
    if (reason === "closed") {
      execution.terminal = { ...execution.terminal, status: "exited" };
    }
    if (reason === "exited" && execution.interruptSentAt !== undefined) {
      deps.logWarning(
        `an interrupted command ran on: ${describeRanOn(execution)}`,
      );
    }
  };

  // Ctrl+C asks a program to stop; it can catch it and run to its own end.
  // An exit code of 130 for every interrupted command hid a run that went on
  // and failed with 3.
  const endReason = (
    execution: ExecutionState,
    endedAt?: number,
  ): CompletionReason => {
    const sentAt = execution.interruptSentAt;
    if (sentAt === undefined) return "exited";
    if (endedAt === undefined) return "interrupted";
    return endedAt - sentAt <= INTERRUPT_STOP_MS ? "interrupted" : "exited";
  };

  // A dispatch failure with no reason sent a prod agent off blaming the
  // inactive workspace, when every live terminal buffer was in use.
  const failDispatch = (execution: ExecutionState, reason: string) => {
    if (execution.completedAt !== undefined) return;
    execution.dispatchError = reason;
    finishExecution(execution, "dispatch_failed", null);
  };

  const refreshExecutionCompletion = async (
    execution: ExecutionState,
  ): Promise<boolean> => {
    if (execution.completedAt !== undefined) return true;
    if (execution.phase === "queued") return false;
    const match = /^terminal:(\d+):(\d+)$/.exec(execution.terminalId);
    const leafId = match ? Number(match[2]) : Number.NaN;
    const state = Number.isSafeInteger(leafId)
      ? deps.getSessionState(leafId)
      : null;
    if (!state || state.shellExited) {
      finishExecution(execution, "closed", null);
      return true;
    }
    // The PTY refused the command's input: nothing reached the shell.
    if (
      execution.phase === "dispatched" &&
      execution.dispatchedAt !== undefined &&
      state.writeError &&
      state.writeError.at >= execution.dispatchedAt
    ) {
      failDispatch(
        execution,
        `The terminal did not take the command: ${state.writeError.message}`,
      );
      return true;
    }
    // A prompt redraw that ended before this command was typed is not its end.
    for (const done of state.commandCompletions ?? []) {
      if (
        done.generation === execution.baselineGeneration + 1 &&
        done.at !== undefined &&
        execution.dispatchedAt !== undefined &&
        done.at < execution.dispatchedAt
      ) {
        execution.baselineGeneration = done.generation;
      }
    }
    const targetGeneration = execution.baselineGeneration + 1;
    const completion = state.commandCompletions?.find(
      (candidate) => candidate.generation === targetGeneration,
    );
    if (completion || (state.commandGeneration ?? 0) >= targetGeneration) {
      finishExecution(
        execution,
        endReason(execution, completion?.at),
        completion?.exitCode ?? null,
        completion?.at,
      );
      return true;
    }
    const sentAt = execution.interruptSentAt;
    if (
      sentAt !== undefined &&
      Date.now() - sentAt >= INTERRUPT_UNCONFIRMED_MS &&
      Date.now() - (execution.foregroundCheckedAt ?? 0) >= FOREGROUND_RECHECK_MS
    ) {
      const checkedAt = Date.now();
      execution.foregroundCheckedAt = checkedAt;
      if (await deps.hasForegroundProcess(leafId)) {
        execution.programSeenAt = checkedAt;
        execution.noProgramSince = undefined;
      } else {
        execution.noProgramSince ??= checkedAt;
        if (checkedAt - execution.noProgramSince >= UNCONFIRMED_EMPTY_MS) {
          execution.endUnconfirmed = true;
          // The same rule as a marked end: a program still running past
          // INTERRUPT_STOP_MS ran on.
          const ranOn =
            execution.programSeenAt !== undefined &&
            execution.programSeenAt - (execution.interruptSentAt ?? sentAt) >
              INTERRUPT_STOP_MS;
          finishExecution(execution, ranOn ? "exited" : "interrupted", null);
          return true;
        }
      }
    }
    const shellBusy = state.commandRunning || state.blockMode !== "prompt";
    // The shell took the line as the start of a longer command and waits for
    // the rest: no command began, and nothing ever ended this execution. It
    // read busy for good while the terminal looked idle, and text typed next
    // would have joined the unfinished line.
    if (
      execution.usesOsc &&
      execution.phase === "dispatched" &&
      !shellBusy &&
      execution.dispatchedAt !== undefined &&
      Date.now() - execution.dispatchedAt >= UNFINISHED_COMMAND_MS &&
      continuationPrompt(deps.getBuffer(leafId) ?? "")
    ) {
      deps.write(leafId, "\x03");
      failDispatch(execution, UNFINISHED_COMMAND);
      return true;
    }
    if (shellBusy && execution.phase === "dispatched") {
      execution.phase = "running";
      execution.runningAt = Date.now();
    }
    let completed = false;
    if (!completed && !execution.usesOsc) {
      const foreground = await deps.hasForegroundProcess(leafId);
      const busy = shellBusy || foreground;
      if (busy && execution.phase === "dispatched") {
        execution.phase = "running";
        execution.runningAt = Date.now();
      }
      execution.sawBusy ||= busy;
      const outputChanged =
        bufferFingerprint(deps.getBuffer(leafId) ?? "") !==
        execution.initialFingerprint;
      completed =
        !busy &&
        (execution.sawBusy ||
          (outputChanged && Date.now() - execution.startedAt >= 250));
    }
    if (completed) finishExecution(execution, endReason(execution), null);
    return completed;
  };

  /** The shell's state once its PTY is open and it has ended its first
   *  prompt, or why the command cannot wait for that. A command typed earlier
   *  lands ahead of the prompt. */
  const awaitShellStart = async (
    leafId: number,
    initialState: TerminalSessionState,
    deadline: number,
    timeoutMs: number,
  ): Promise<TerminalSessionState | string> => {
    let state = initialState;
    while (!state.ready || shellStarting(state)) {
      if (Date.now() >= deadline) return firstPromptMissing(timeoutMs);
      await new Promise((resolveDelay) =>
        setTimeout(resolveDelay, INITIAL_PROMPT_SYNC_POLL_MS),
      );
      const next = deps.getSessionState(leafId);
      if (!next || next.shellExited) return shellGoneReason(next);
      state = next;
    }
    return state;
  };

  /** The shell's state once the live buffer has parsed its first prompt
   *  mark, or why the command cannot wait for it. */
  const synchronizeInitialPrompt = async (
    leafId: number,
    initialState: TerminalSessionState,
    deadline: number,
    timeoutMs: number,
  ): Promise<TerminalSessionState | string> => {
    if (
      !shellSupportsOsc(initialState.shell) ||
      (initialState.commandGeneration ?? 0) > 0
    ) {
      return initialState;
    }
    let state: TerminalSessionState | null = initialState;
    while (Date.now() < deadline) {
      await new Promise((resolveDelay) =>
        setTimeout(resolveDelay, INITIAL_PROMPT_SYNC_POLL_MS),
      );
      state = deps.getSessionState(leafId);
      if (!state || state.shellExited)
        return "The shell exited before the command was sent.";
      if ((state.commandGeneration ?? 0) > 0) return state;
    }
    return firstPromptMissing(timeoutMs);
  };

  const dispatchExecution = async (execution: ExecutionState) => {
    if (execution.phase !== "queued") return;
    // One wait for the first prompt, whether the shell is still starting or
    // only its live buffer has yet to parse the mark, as long as the session
    // looks for it.
    const timeoutMs = deps.initialPromptSyncTimeoutMs ?? FIRST_PROMPT_WAIT_MS;
    const deadline = Date.now() + timeoutMs;
    // A terminal just opened, or a restored one started for this command, has
    // no session until its tab mounts.
    const tabOpen = () =>
      deps.getTabs().some((tab) => tab.id === execution.terminal.tabId);
    let queuedState = deps.getSessionState(execution.terminal.leafId);
    while (
      !queuedState &&
      Date.now() < deadline &&
      execution.phase === "queued" &&
      tabOpen()
    ) {
      await new Promise((resolveDelay) =>
        setTimeout(resolveDelay, INITIAL_PROMPT_SYNC_POLL_MS),
      );
      queuedState = deps.getSessionState(execution.terminal.leafId);
    }
    if (execution.phase !== "queued") return;
    if (!queuedState && !tabOpen()) {
      finishExecution(execution, "closed", null);
      return;
    }
    if (!queuedState) {
      failDispatch(
        execution,
        `The terminal did not start a shell within ${Math.round(timeoutMs / 1000)} s, so nothing was sent.`,
      );
      return;
    }
    if (queuedState.spawnFailed) {
      failDispatch(execution, shellGoneReason(queuedState));
      return;
    }
    if (queuedState.shellExited) {
      finishExecution(execution, "closed", null);
      return;
    }
    const state = await awaitShellStart(
      execution.terminal.leafId,
      queuedState,
      deadline,
      timeoutMs,
    );
    if (typeof state === "string") {
      failDispatch(execution, state);
      return;
    }
    const busy = await busyShellReason(state, () =>
      programRuns(execution.terminal.leafId),
    );
    if (busy) {
      failDispatch(execution, busy);
      return;
    }
    if (execution.phase !== "queued") return;
    if (!deps.prepare(execution.terminal.leafId)) {
      failDispatch(execution, deps.unpreparedReason(execution.terminal.leafId));
      return;
    }
    const preparedState = deps.getSessionState(execution.terminal.leafId);
    const latestState = preparedState
      ? await synchronizeInitialPrompt(
          execution.terminal.leafId,
          preparedState,
          deadline,
          timeoutMs,
        )
      : "The terminal closed before the command was sent.";
    if (typeof latestState === "string") {
      failDispatch(execution, latestState);
      return;
    }
    const unready = await busyShellReason(latestState, () =>
      programRuns(execution.terminal.leafId),
    );
    if (unready) {
      failDispatch(execution, unready);
      return;
    }
    // Cancelled while the first prompt was awaited: the agent was told nothing
    // would run.
    if (execution.phase !== "queued") return;
    const raw = deps.getBuffer(execution.terminal.leafId) ?? "";
    // Read now: a prompt the shell drew again while the checks above awaited
    // (Ctrl+C clearing the input line) ended before this command.
    execution.baselineGeneration =
      deps.getSessionState(execution.terminal.leafId)?.commandGeneration ??
      latestState.commandGeneration ??
      0;
    execution.cursor = output.checkpoint(execution.terminalId, raw);
    execution.initialFingerprint = bufferFingerprint(raw);
    execution.usesOsc = shellSupportsOsc(latestState.shell);
    execution.phase = "dispatched";
    execution.dispatchedAt = Date.now();
    if (!deps.write(execution.terminal.leafId, `${execution.inputText}\r`)) {
      finishExecution(execution, "closed", null);
    }
  };

  const batchAnsweredAt = new Map<number, number>();

  /** Answers cmd's batch question with its yes letter and Enter, as a user
   *  would: another Ctrl+C there means no, and the batch went on to its next
   *  step. True while the question is on screen, answered now or a moment
   *  ago, so no Ctrl+C follows. */
  const answerBatchQuestion = (
    leafId: number,
    execution?: ExecutionState,
  ): boolean => {
    const yes = batchJobQuestion(deps.getBuffer(leafId) ?? "");
    if (!yes) return false;
    const now = Date.now();
    for (const [leaf, at] of batchAnsweredAt) {
      if (now - at >= BATCH_ANSWER_GAP_MS) batchAnsweredAt.delete(leaf);
    }
    if (batchAnsweredAt.has(leafId)) return true;
    if (!deps.write(leafId, `${yes}\r`)) return false;
    batchAnsweredAt.set(leafId, now);
    if (execution) execution.answeredBatchQuestion = true;
    return true;
  };

  /** Looks for cmd's batch question for a while after a Ctrl+C, without
   *  holding up the interrupt's answer. */
  const watchForBatchQuestion = (
    leafId: number,
    execution?: ExecutionState,
  ) => {
    const until = Date.now() + BATCH_QUESTION_WATCH_MS;
    const look = () => {
      const state = deps.getSessionState(leafId);
      if (!state || state.shellExited) return;
      // Back at a marked prompt: the command ended without asking.
      if (
        shellSupportsOsc(state.shell) &&
        !state.commandRunning &&
        state.blockMode === "prompt"
      ) {
        return;
      }
      if (answerBatchQuestion(leafId, execution) || Date.now() >= until) {
        return;
      }
      setTimeout(look, BATCH_QUESTION_POLL_MS);
    };
    setTimeout(look, BATCH_QUESTION_POLL_MS);
  };

  /** Sends Ctrl+C once more to a program the last one could not reach: one
   *  that started after it, or so shortly before that it may not have joined
   *  the console yet. A program that had run longer when a Ctrl+C came never
   *  gets another, and none gets more than one: another makes a program that
   *  stops in its own time (terraform, docker compose) quit at once. Without
   *  start times, nothing is sent. */
  const watchForLateProgram = (leafId: number, execution: ExecutionState) => {
    const programsOf = deps.foregroundProcesses;
    if (!programsOf) return;
    const watch = (execution.lateProgramWatch ?? 0) + 1;
    execution.lateProgramWatch = watch;
    const until = Date.now() + LATE_PROGRAM_WATCH_MS;
    const traceUntil = Date.now() + LATE_PROGRAM_TRACE_MS;
    execution.lateWatchTrace ??= {
      firstCtrlCAt: execution.interruptSentAt ?? Date.now(),
      looks: 0,
      slowestLookMs: 0,
      programs: new Map(),
    };
    const trace = execution.lateWatchTrace;
    /** One look; false once there is nothing left to watch. */
    const look = async (): Promise<boolean> => {
      if (execution.lateProgramWatch !== watch || Date.now() >= traceUntil) {
        return false;
      }
      if (await refreshExecutionCompletion(execution)) return false;
      const askedAt = Date.now();
      const programs = await programsOf(leafId);
      const now = Date.now();
      trace.looks += 1;
      trace.slowestLookMs = Math.max(trace.slowestLookMs, now - askedAt);
      for (const program of programs) {
        if (trace.programs.has(program.pid)) continue;
        trace.programs.set(program.pid, {
          name: program.name,
          fromCtrlCMs:
            program.startedAt === undefined
              ? null
              : program.startedAt - trace.firstCtrlCAt,
        });
      }
      // Past the watch it only notes what runs.
      if (now >= until) return true;
      if (programs.length > 0) {
        execution.programSeenAt = now;
        execution.noProgramSince = undefined;
      }
      const sentAt = execution.interruptSentAt ?? now;
      const key = (program: ShellProcess) =>
        `${program.pid}:${program.startedAt}`;
      const late = programs.filter(
        (program) =>
          program.startedAt !== undefined &&
          program.startedAt > sentAt - LATE_PROGRAM_MARGIN_MS &&
          now - program.startedAt >= LATE_PROGRAM_AGE_MS &&
          !execution.resentPrograms?.has(key(program)),
      );
      if (
        late.length > 0 &&
        now - sentAt >= INTERRUPT_RESEND_GAP_MS &&
        (execution.interruptResent ?? 0) < MAX_INTERRUPT_RESENDS &&
        execution.lateProgramWatch === watch &&
        execution.completedAt === undefined &&
        !pagerOnScreen(deps.getScreen?.(leafId) ?? "") &&
        !pagerOnScreen(deps.getBuffer(leafId) ?? "") &&
        !answerBatchQuestion(leafId, execution)
      ) {
        if (!deps.write(leafId, "\x03")) return false;
        execution.interruptSentAt = Date.now();
        execution.resentPrograms ??= new Set();
        for (const program of late) execution.resentPrograms.add(key(program));
        execution.interruptResent = (execution.interruptResent ?? 0) + 1;
        execution.resentTo ??= late.map(
          (program) => `${program.name} (pid ${program.pid})`,
        );
        watchForBatchQuestion(leafId, execution);
      }
      return true;
    };
    const tick = () => {
      look().then(
        (again) => {
          if (!again) return;
          const traceOnly = Date.now() >= until;
          setTimeout(
            tick,
            traceOnly ? LATE_PROGRAM_TRACE_POLL_MS : LATE_PROGRAM_POLL_MS,
          );
        },
        (cause: unknown) => {
          deps.logWarning(`the late-program watch stopped: ${String(cause)}`);
        },
      );
    };
    setTimeout(tick, LATE_PROGRAM_POLL_MS);
  };

  const pendingExecution = async (
    id: string,
  ): Promise<ExecutionState | undefined> => {
    for (const execution of executions.values()) {
      if (
        execution.terminalId === id &&
        !(await refreshExecutionCompletion(execution))
      ) {
        return execution;
      }
    }
    return undefined;
  };

  const hasPendingExecution = async (id: string): Promise<boolean> =>
    (await pendingExecution(id)) !== undefined;

  /** Which execution holds a terminal, so an agent can wait for it or stop
   *  it instead of only hearing that the terminal is busy. */
  const pendingMessage = (id: string, execution: ExecutionState): string => {
    const since = Math.round(
      (Date.now() - (execution.dispatchedAt ?? execution.startedAt)) / 1000,
    );
    return execution.phase === "queued"
      ? `${id} still holds ${execution.executionId}, queued ${since} s ago for its first prompt; wait for it with terminal_wait or cancel it with terminal_interrupt`
      : `${id} is still running ${execution.executionId}, sent ${since} s ago; wait for it with terminal_wait or stop it with terminal_interrupt`;
  };

  // A terminal an agent opened stays its own after a CLI ran in it: dropped
  // from every tool but terminal_close, it looked closed to the agent.
  const resolve = async (
    params: Record<string, unknown>,
    verifyForeground = true,
    opened: ReadonlySet<string> = openedTerminals,
  ): Promise<
    | {
        ok: true;
        workspace: { id: string; root: string };
        terminals: SharedTerminalDescriptor[];
      }
    | { ok: false; response: AgentAutomationResponse }
  > => {
    const workspace = resolveAgentWorkspace(deps.getSpaces(), params.workspace);
    if (!workspace.ok) {
      return {
        ok: false,
        response: automationError("workspace_not_found", workspace.error),
      };
    }
    return {
      ok: true,
      workspace: workspace.space,
      terminals: await collectSharedTerminals(
        deps,
        workspace.space,
        verifyForeground,
        opened,
        deps.spawnedTerminals,
      ),
    };
  };

  /** The agent's terminal `id` names in `space`, or null when it names no
   *  terminal an agent holds. */
  const agentTerminal = (
    space: { id: string },
    id: string,
  ): AgentTerminal | null => {
    const match = /^terminal:(\d+):(\d+)$/.exec(id);
    if (!match) return null;
    const tabId = Number(match[1]);
    const leafId = Number(match[2]);
    const tab = deps
      .getTabs()
      .find(
        (candidate): candidate is TerminalTab =>
          candidate.kind === "terminal" &&
          candidate.id === tabId &&
          candidate.spaceId === space.id,
      );
    if (!tab || !leafIds(tab.paneTree).includes(leafId)) return null;
    const session = agentSessionAt(deps.getSessions(), tabId, leafId);
    const spawned = deps.spawnedTerminals?.has(id) ?? false;
    const starting = spawned && deps.spawnedTerminals?.get(id) === false;
    if (!session && !starting && !tab.agent) return null;
    return {
      tabId,
      leafId,
      agentId: session
        ? agentIdFor(session.name, session.agent, session.tabId)
        : null,
      spawned,
    };
  };

  const resolveTarget = async (
    params: Record<string, unknown>,
    verifyForeground = true,
    opened?: ReadonlySet<string>,
  ) => {
    const resolved = await resolve(params, verifyForeground, opened);
    if (!resolved.ok) return resolved;
    const id = paramString(params, "terminalId");
    if (!id) {
      return {
        ok: false as const,
        response: automationError("invalid_request", "terminalId is required"),
      };
    }
    let terminal = resolved.terminals.find(
      (candidate) => candidate.terminalId === id,
    );
    const settleUntil = Date.now() + OPENED_TERMINAL_SETTLE_MS;
    while (!terminal && openedTerminals.has(id) && Date.now() < settleUntil) {
      await new Promise((resolveDelay) =>
        setTimeout(resolveDelay, OPENED_TERMINAL_POLL_MS),
      );
      const again = await resolve(params, verifyForeground, opened);
      if (!again.ok) return again;
      terminal = again.terminals.find(
        (candidate) => candidate.terminalId === id,
      );
    }
    if (!terminal) {
      output.remove(id);
      // An agent's terminal exists: "not available" read as if it had gone
      // (round 66, R66-1).
      const agent = agentTerminal(resolved.workspace, id);
      return {
        ok: false as const,
        response: automationError(
          "terminal_not_found",
          agent
            ? agentTerminalMessage(id, agent)
            : `shared terminal is not available in workspace: ${id}`,
        ),
      };
    }
    return { ok: true as const, terminal };
  };

  /** Whether a program runs in the terminal, past the helpers of a prompt its
   *  shell is still drawing. */
  const programRuns = async (leafId: number) => {
    while (await deps.hasForegroundProcess(leafId)) {
      const ends = deps.getSessionState(leafId)?.commandCompletions ?? [];
      const ended = ends[ends.length - 1]?.at ?? 0;
      if (Date.now() - ended >= PROMPT_HELPERS_MS) return true;
      await new Promise((resolveDelay) =>
        setTimeout(resolveDelay, PROMPT_HELPERS_POLL_MS),
      );
    }
    return false;
  };

  const requireIdle = async (
    params: Record<string, unknown>,
    acceptStarting = false,
  ) => {
    const target = await resolveTarget(params, false);
    if (!target.ok) return target;
    const pending = await pendingExecution(target.terminal.terminalId);
    if (pending) {
      return {
        ok: false as const,
        response: automationError(
          "terminal_busy",
          pendingMessage(target.terminal.terminalId, pending),
        ),
      };
    }
    const latestState = deps.getSessionState(target.terminal.leafId);
    const status =
      target.terminal.status === "dormant"
        ? "dormant"
        : baseStatus(latestState);
    // What has not started is started for the caller: a restored tab is
    // mounted, a shell that could not start tries again. Waiting alone never
    // helped: nothing else started them.
    let started = false;
    if (status === "dormant" && deps.warm) {
      deps.warm(target.terminal.tabId);
      started = true;
    } else if (status === "failed") {
      started = deps.retryStart?.(target.terminal.leafId) ?? false;
    }
    // A command for a shell still starting, even before its session exists
    // (a terminal just opened, or one started for this command), goes out at
    // its first prompt (dispatchExecution).
    const starting = acceptStarting && (status === "starting" || started);
    if (status !== "idle" && !starting) {
      return {
        ok: false as const,
        response: automationError(
          status === "failed" && !started
            ? "terminal_unavailable"
            : "terminal_busy",
          unreadyMessage(
            target.terminal.terminalId,
            status,
            started,
            latestState?.spawnError,
          ),
        ),
      };
    }
    if (latestState?.inputPending) {
      return {
        ok: false as const,
        response: automationError(
          "terminal_input_pending",
          `${target.terminal.terminalId} contains unsubmitted input; submit or clear it before executing another command`,
        ),
      };
    }
    if (starting) return target;
    const shellBusy =
      !latestState?.ready ||
      latestState.shellExited ||
      latestState.commandRunning ||
      latestState.blockMode !== "prompt";
    if (shellBusy || (await programRuns(target.terminal.leafId))) {
      const running = shellBusy ? "" : await runningIn(target.terminal.leafId);
      return {
        ok: false as const,
        response: automationError(
          "terminal_busy",
          `${target.terminal.terminalId} is no longer idle${running}`,
        ),
      };
    }
    return target;
  };

  return {
    /** `deadline` is when the caller stops waiting: nothing is written to a
     *  terminal after it. */
    async handle(
      method: TerminalAutomationMethod,
      params: Record<string, unknown>,
      deadline?: number,
    ): Promise<AgentAutomationResponse> {
      if (method === "terminal_open") {
        const workspace = resolveAgentWorkspace(
          deps.getSpaces(),
          params.workspace,
        );
        if (!workspace.ok) {
          return automationError("workspace_not_found", workspace.error);
        }
        const title = sanitizeTerminalTitle(params.title);
        if (!title.ok) return automationError("invalid_request", title.error);
        const opened = deps.open(workspace.space, title.title);
        if (!opened) {
          return automationError(
            "terminal_open_failed",
            `could not create a shared terminal in ${workspace.space.root}`,
          );
        }
        const id = terminalId(opened.tabId, opened.leafId);
        openedTerminals.add(id);
        while (openedTerminals.size > MAX_TRACKED_TERMINALS) {
          const oldest = openedTerminals.values().next().value;
          if (oldest === undefined) break;
          openedTerminals.delete(oldest);
        }
        return {
          result: {
            ok: true,
            placement: opened.activated ? "visible-first-tab" : "background",
            terminal: {
              terminalId: id,
              title: title.title,
              tabId: opened.tabId,
              leafId: opened.leafId,
              spaceId: workspace.space.id,
              workspace: workspace.space.root,
              cwd: workspace.space.root,
              active: opened.activated === true,
              status: "starting",
              shell: "unknown",
            } satisfies SharedTerminalDescriptor,
          },
        };
      }

      if (method === "terminal_close") {
        // An agent agent_spawn started can be ended by force: one stuck at a
        // question of its own (Codex's update prompt) never took '/exit', no
        // tool ended it, and its spawner killed the process by PID (round 66,
        // R66-1). Agents the user opened are never closed this way.
        const spawnedId = paramString(params, "terminalId");
        if (spawnedId && deps.spawnedTerminals?.has(spawnedId)) {
          const workspace = resolveAgentWorkspace(
            deps.getSpaces(),
            params.workspace,
          );
          if (!workspace.ok) {
            return automationError("workspace_not_found", workspace.error);
          }
          const agent = agentTerminal(workspace.space, spawnedId);
          if (
            agent &&
            (agent.agentId !== null ||
              deps.spawnedTerminals.get(spawnedId) === false)
          ) {
            if (params.force !== true) {
              return automationError(
                "terminal_busy",
                agentTerminalMessage(spawnedId, agent),
              );
            }
            if (!deps.close(agent.tabId, agent.leafId, true)) {
              return automationError(
                "terminal_close_failed",
                `${spawnedId} could not be closed safely`,
              );
            }
            openedTerminals.delete(spawnedId);
            deps.spawnedTerminals.delete(spawnedId);
            output.remove(spawnedId);
            for (const [executionId, execution] of executions) {
              if (execution.terminalId === spawnedId) {
                executions.delete(executionId);
              }
            }
            return {
              result: {
                ok: true,
                closed: true,
                terminalId: spawnedId,
                tabId: agent.tabId,
                leafId: agent.leafId,
                workspace: workspace.space.root,
                endedAgent: agent.agentId,
              },
            };
          }
        }
        const target = await resolveTarget(params, false, openedTerminals);
        if (!target.ok) return target.response;
        const id = target.terminal.terminalId;
        // Ends the shell and whatever runs in it: a terminal whose execution
        // never saw its end refused to close for good.
        const force = params.force === true;
        const forceHint =
          "; force: true closes it anyway, ending its shell and everything running in it";
        if (!openedTerminals.has(id)) {
          return automationError(
            "terminal_not_owned",
            `${id} was not opened by terminal_open in this application session`,
          );
        }
        if (
          isAgentLeaf(
            deps.getSessions(),
            target.terminal.tabId,
            target.terminal.leafId,
          )
        ) {
          return automationError(
            "terminal_busy",
            `${id} is running an agent CLI, which agent_list shows; end it before closing the terminal`,
          );
        }
        const pending = await pendingExecution(id);
        if (pending && !force) {
          return automationError(
            "terminal_busy",
            `${pendingMessage(id, pending)}${forceHint}`,
          );
        }
        const state = deps.getSessionState(target.terminal.leafId);
        if (state?.inputPending && !force) {
          return automationError(
            "terminal_input_pending",
            `${id} contains unsubmitted input; submit or clear it before closing${forceHint}`,
          );
        }
        if (
          !force &&
          (!state ||
            (!state.shellExited &&
              (!state.ready ||
                state.commandRunning ||
                state.blockMode !== "prompt" ||
                (await deps.hasForegroundProcess(target.terminal.leafId)))))
        ) {
          const running = await runningIn(target.terminal.leafId);
          return automationError(
            "terminal_busy",
            `${id} is starting or running a foreground process${running}${forceHint}`,
          );
        }
        if (!deps.close(target.terminal.tabId, target.terminal.leafId)) {
          return automationError(
            "terminal_close_failed",
            `${id} could not be closed safely`,
          );
        }
        openedTerminals.delete(id);
        deps.spawnedTerminals?.delete(id);
        output.remove(id);
        for (const [executionId, execution] of executions) {
          if (execution.terminalId === id) executions.delete(executionId);
        }
        return {
          result: {
            ok: true,
            closed: true,
            ...(force && { forced: true }),
            terminalId: id,
            tabId: target.terminal.tabId,
            leafId: target.terminal.leafId,
            workspace: target.terminal.workspace,
          },
        };
      }

      if (method === "terminal_list") {
        const resolved = await resolve(params);
        if (!resolved.ok) return resolved.response;
        const terminals = await Promise.all(
          resolved.terminals.map(async (terminal) =>
            (await hasPendingExecution(terminal.terminalId))
              ? { ...terminal, status: "busy" as const }
              : terminal,
          ),
        );
        return {
          result: {
            workspace: resolved.workspace.root,
            spaceId: resolved.workspace.id,
            terminals,
            ...(terminals.some((terminal) => terminal.status === "dormant")
              ? {
                  note: "A dormant terminal was restored, or paused with its workspace, and has not started yet; terminal_execute starts it and runs the command once its prompt shows.",
                }
              : {}),
          },
        };
      }

      if (method === "terminal_read") {
        const target = await resolveTarget(params, false);
        if (!target.ok) return target.response;
        const raw = deps.getBuffer(target.terminal.leafId);
        if (raw === null) {
          // A read starts nothing: one sweep over a workspace's terminals woke
          // every restored one, a shell and its memory each (R80-1).
          return automationError(
            "terminal_unavailable",
            target.terminal.status === "dormant"
              ? unreadyMessage(target.terminal.terminalId, "dormant", false)
              : "terminal buffer is not available",
          );
        }
        return {
          result: {
            terminal: target.terminal,
            ...output.read(
              target.terminal.terminalId,
              raw,
              params.cursor,
              params.maxChars,
            ),
          },
        };
      }

      if (method === "terminal_wait") {
        const executionId = paramString(params, "executionId");
        if (!executionId) {
          return automationError("invalid_request", "executionId is required");
        }
        const requestedTerminalId = paramString(params, "terminalId");
        if (!requestedTerminalId) {
          return automationError("invalid_request", "terminalId is required");
        }
        const workspace = resolveAgentWorkspace(
          deps.getSpaces(),
          params.workspace,
        );
        if (!workspace.ok) {
          return automationError("workspace_not_found", workspace.error);
        }
        const execution = executions.get(executionId);
        if (
          !execution ||
          execution.terminalId !== requestedTerminalId ||
          execution.workspace !== workspace.space.root
        ) {
          return automationError(
            "execution_not_found",
            `shared terminal execution is not available: ${executionId}`,
          );
        }
        const target = await resolveTarget(params, false);
        const completedBeforeWait = execution.completedAt !== undefined;
        const repeatedWait = execution.waitCount > 0;
        execution.waitCount += 1;
        const timeout =
          typeof params.timeout === "number" && Number.isInteger(params.timeout)
            ? Math.max(100, Math.min(MAX_WAIT_MS, params.timeout))
            : 10_000;
        const deadline = Date.now() + timeout;
        let completed = completedBeforeWait;
        let followedAt = 0;
        while (Date.now() < deadline) {
          if (await refreshExecutionCompletion(execution)) {
            completed = true;
            break;
          }
          // Read along while it runs: 700 lines between two reads shared
          // nothing with the lines read before, read as a repaint, and the
          // command's start was lost.
          if (
            target.ok &&
            execution.phase !== "queued" &&
            Date.now() - followedAt >= OUTPUT_FOLLOW_MS
          ) {
            followedAt = Date.now();
            output.checkpoint(
              execution.terminalId,
              deps.getBuffer(execution.terminal.leafId) ?? "",
            );
          }
          const remaining = deadline - Date.now();
          if (remaining > 0) {
            await new Promise((resolveDelay) =>
              setTimeout(resolveDelay, Math.min(WAIT_POLL_MS, remaining)),
            );
          }
        }
        completed ||= execution.completedAt !== undefined;
        let state = deps.getSessionState(execution.terminal.leafId);
        const outputNow = (): ExecutionOutput =>
          output.execution(
            execution.terminalId,
            deps.getBuffer(execution.terminal.leafId) ?? "",
            execution.cursor,
            execution.inputText,
            // Only a command that was typed and ran has an echo to look for.
            completed &&
              execution.dispatchedAt !== undefined &&
              execution.completionReason !== "dispatch_failed",
            () => deps.getHistory?.(execution.terminal.leafId) ?? null,
          );
        let current: ExecutionOutput =
          execution.finalOutput ??
          (target.ok
            ? outputNow()
            : {
                text: "",
                cursorAt: () => execution.cursor,
                reset: false,
                replayed: false,
                historyTruncated: false,
              });
        if (
          !execution.finalOutput &&
          target.ok &&
          completed &&
          execution.dispatchedAt !== undefined &&
          execution.completionReason !== "closed" &&
          execution.completionReason !== "dispatch_failed" &&
          (current.reset ||
            !current.text.trim() ||
            !state?.ready ||
            (!state.shellExited &&
              (state.commandRunning || state.blockMode !== "prompt")))
        ) {
          let previousLength = current.text.length;
          let stableIdlePolls = 0;
          for (let attempt = 0; attempt < 12; attempt += 1) {
            await new Promise((resolveDelay) => setTimeout(resolveDelay, 75));
            const candidate = outputNow();
            if (candidate.text.length > current.text.length)
              current = candidate;
            state = deps.getSessionState(execution.terminal.leafId);
            const shellIdle =
              !!state?.ready &&
              (state.shellExited ||
                (!state.commandRunning && state.blockMode === "prompt"));
            stableIdlePolls =
              shellIdle && current.text.length === previousLength
                ? stableIdlePolls + 1
                : 0;
            previousLength = current.text.length;
            if (stableIdlePolls >= 2) break;
          }
        }
        if (completed) {
          execution.finalOutput ??= current;
          current = execution.finalOutput;
        }
        const clipped = clipExecutionOutput(
          current.text,
          clampMaxChars(params.maxChars),
        );
        const refreshed = target.ok
          ? await resolveTarget(params, false)
          : target;
        const endedAfterInterruptMs =
          completed &&
          execution.endMarked &&
          execution.completedAt !== undefined &&
          execution.interruptSentAt !== undefined
            ? execution.completedAt - execution.interruptSentAt
            : undefined;
        const ranOnNote =
          execution.completionReason === "exited" &&
          endedAfterInterruptMs !== undefined
            ? `The command ended ${(endedAfterInterruptMs / 1000).toFixed(1)} s after the Ctrl+C: it ran on or took that long to stop. exitCode is what its shell reported.`
            : undefined;
        const ranOnFor =
          (execution.programSeenAt ?? 0) - (execution.interruptSentAt ?? 0);
        const unconfirmedWhat =
          execution.completionReason === "exited"
            ? `The command ran on after the Ctrl+C: one of its programs still ran ${(ranOnFor / 1000).toFixed(1)} s after it, and none is left now`
            : "Anbo sent Ctrl+C and none of the command's programs is left";
        const unconfirmedNote = execution.endUnconfirmed
          ? `${unconfirmedWhat}, but its shell never marked the end, so the exit code is unknown. terminal_read shows the screen.`
          : undefined;
        const resentNote = execution.interruptResent
          ? `${execution.resentTo?.join(", ") ?? "A program"} started too late for Anbo's Ctrl+C, which reached only its shell, so Anbo sent Ctrl+C ${execution.interruptResent === 1 ? "once more" : `${execution.interruptResent} more times`}.`
          : undefined;
        // The UI stands behind the shell's output and is asking for the rest.
        const outputStalled =
          !completed && (state?.outputStalledSince ?? null) !== null;
        const stalledNote = outputStalled
          ? "Anbo has not received this terminal's latest output yet and is asking for it again; wait again."
          : undefined;
        const note =
          [resentNote, ranOnNote ?? unconfirmedNote ?? stalledNote]
            .filter((part) => part !== undefined)
            .join(" ") || undefined;
        return {
          result: {
            executionId,
            completed,
            timedOut: !completed && !state?.shellExited,
            phase: execution.phase,
            completionReason: execution.completionReason ?? null,
            ...(execution.dispatchError !== undefined && {
              dispatchError: execution.dispatchError,
            }),
            interrupted: execution.completionReason === "interrupted",
            ...(execution.interruptRequested && { interruptRequested: true }),
            ...(execution.interruptResent !== undefined && {
              interruptResent: execution.interruptResent,
            }),
            ...(execution.dispatchedAt === undefined &&
              execution.completionReason === "interrupted" && {
                cancelledBeforeDispatch: true,
              }),
            ...(endedAfterInterruptMs !== undefined && {
              endedAfterInterruptMs,
            }),
            ...(execution.answeredBatchQuestion && {
              answeredBatchQuestion: true,
            }),
            ...(execution.endUnconfirmed && { endUnconfirmed: true }),
            ...(outputStalled && { outputStalled: true }),
            ...(note !== undefined && { note }),
            exitCode: completed ? execution.exitCode : null,
            // From when the command was typed: the wait for a starting shell
            // before it is queuedMs, which had made a 90 s job read 110 s.
            durationMs:
              (execution.completedAt ?? Date.now()) -
              (execution.dispatchedAt ?? execution.startedAt),
            ...(execution.dispatchedAt !== undefined && {
              queuedMs: execution.dispatchedAt - execution.startedAt,
            }),
            repeated: repeatedWait,
            terminal: refreshed.ok ? refreshed.terminal : execution.terminal,
            output: clipped.output,
            cursor: current.cursorAt(current.text.length),
            truncated: clipped.omittedChars > 0,
            hasMore: false,
            historyTruncated: current.historyTruncated,
            reset: current.reset,
            replayed: current.replayed,
            ...(clipped.omittedChars > 0 && {
              omittedChars: clipped.omittedChars,
              ...(current.pageable !== false && {
                omittedCursor: current.cursorAt(clipped.omittedFrom),
              }),
            }),
          },
        };
      }

      if (method === "terminal_interrupt") {
        const target = await resolveTarget(params, false);
        if (!target.ok) return target.response;
        const requestedExecutionId = paramString(params, "executionId");
        const execution = requestedExecutionId
          ? executions.get(requestedExecutionId)
          : Array.from(executions.values())
              .reverse()
              .find(
                (candidate) =>
                  candidate.terminalId === target.terminal.terminalId &&
                  candidate.workspace === target.terminal.workspace &&
                  candidate.completedAt === undefined,
              );
        if (
          requestedExecutionId &&
          (!execution ||
            execution.terminalId !== target.terminal.terminalId ||
            execution.workspace !== target.terminal.workspace)
        ) {
          return automationError(
            "execution_not_found",
            `shared terminal execution is not available: ${requestedExecutionId}`,
          );
        }
        if (execution) await refreshExecutionCompletion(execution);
        // A Ctrl+C before the shell starts the command reaches its prompt
        // instead (INTERRUPT_START_WAIT_MS): it waits for the start first. A
        // program already running is the start, marked or not.
        if (execution?.phase === "dispatched") {
          const until = Date.now() + INTERRUPT_START_WAIT_MS;
          while (
            execution.phase === "dispatched" &&
            execution.completedAt === undefined &&
            Date.now() < until &&
            !(await deps.hasForegroundProcess(target.terminal.leafId))
          ) {
            await new Promise((resolveDelay) =>
              setTimeout(resolveDelay, INTERRUPT_START_POLL_MS),
            );
            await refreshExecutionCompletion(execution);
          }
        }
        if (execution?.completedAt !== undefined) {
          return {
            result: {
              ok: true,
              executionId: execution.executionId,
              phase: execution.phase,
              completionReason: execution.completionReason ?? null,
              ...(execution.dispatchError !== undefined && {
                dispatchError: execution.dispatchError,
              }),
              interrupted: execution.completionReason === "interrupted",
              clearedInput: false,
              alreadyCompleted: true,
              terminal: target.terminal,
            },
          };
        }
        if (execution?.phase === "queued") {
          execution.interruptRequested = true;
          // Nothing ran, so there is no exit code.
          finishExecution(execution, "interrupted", null);
          return {
            result: {
              ok: true,
              executionId: execution.executionId,
              phase: execution.phase,
              completionReason: execution.completionReason,
              interrupted: true,
              clearedInput: false,
              cancelledBeforeDispatch: true,
              terminal: target.terminal,
            },
          };
        }
        const state = deps.getSessionState(target.terminal.leafId);
        if (!state || state.shellExited) {
          return automationError(
            "terminal_unavailable",
            `${target.terminal.terminalId} has no live shell`,
          );
        }
        // Sent right after terminal_open, a Ctrl+C ended the new Windows
        // PowerShell with 0xC000013A, and its tab closed.
        if (!state.ready || shellStarting(state)) {
          return automationError(
            "terminal_busy",
            `${target.terminal.terminalId} is starting, so no Ctrl+C was sent: one before the shell's first prompt can end the shell. Wait until terminal_list shows it idle.`,
          );
        }
        // A pager quits on q and ignores Ctrl+C. The buffer joins less's ":"
        // onto a full-width row above it, so the drawn rows are read first.
        const leafId = target.terminal.leafId;
        if (
          pagerOnScreen(deps.getScreen?.(leafId) ?? "") ||
          pagerOnScreen(deps.getBuffer(leafId) ?? "")
        ) {
          if (execution) {
            execution.interruptRequested = true;
            execution.interruptSentAt = Date.now();
          }
          if (!deps.write(target.terminal.leafId, "q")) {
            return automationError(
              "terminal_unavailable",
              "terminal stopped before the pager could be quit",
            );
          }
          return {
            result: {
              ok: true,
              ...(execution && {
                executionId: execution.executionId,
                phase: execution.phase,
                completionReason: null,
                interruptRequested: true,
              }),
              interrupted: true,
              quitPager: true,
              clearedInput: false,
              terminal: target.terminal,
            },
          };
        }
        if (execution) {
          execution.interruptRequested = true;
          execution.interruptSentAt = Date.now();
          const answered = answerBatchQuestion(
            target.terminal.leafId,
            execution,
          );
          if (!answered) {
            if (!deps.write(target.terminal.leafId, "\x03")) {
              finishExecution(execution, "closed", null);
              return automationError(
                "terminal_unavailable",
                "terminal stopped before the interrupt could be delivered",
              );
            }
            watchForBatchQuestion(target.terminal.leafId, execution);
            watchForLateProgram(target.terminal.leafId, execution);
          }
          return {
            result: {
              ok: true,
              executionId: execution.executionId,
              phase: execution.phase,
              completionReason: null,
              interruptRequested: true,
              interrupted: true,
              ...(answered && { answeredBatchQuestion: true }),
              clearedInput: false,
              terminal: target.terminal,
            },
          };
        }
        // A batch file run straight in cmd waits in the shell itself, with no
        // foreground program to find.
        if (answerBatchQuestion(target.terminal.leafId)) {
          return {
            result: {
              ok: true,
              interrupted: true,
              answeredBatchQuestion: true,
              clearedInput: false,
              terminal: target.terminal,
            },
          };
        }
        // An unfinished line someone typed, which the shell waits for the
        // rest of, reads as idle like a shell at its prompt, and agents could
        // not clear it (round 79).
        if (
          state.inputPending ||
          continuationPrompt(deps.getBuffer(target.terminal.leafId) ?? "")
        ) {
          if (!deps.write(target.terminal.leafId, "\x03")) {
            return automationError(
              "terminal_unavailable",
              "terminal stopped before pending input could be cancelled",
            );
          }
          return {
            result: {
              ok: true,
              interrupted: false,
              clearedInput: true,
              terminal: target.terminal,
            },
          };
        }
        const busy =
          state.commandRunning ||
          state.blockMode !== "prompt" ||
          (await deps.hasForegroundProcess(target.terminal.leafId));
        if (!busy) {
          return automationError(
            "terminal_idle",
            `${target.terminal.terminalId} has no foreground command to interrupt`,
          );
        }
        if (!deps.write(target.terminal.leafId, "\x03")) {
          return automationError(
            "terminal_unavailable",
            "terminal stopped before the interrupt could be delivered",
          );
        }
        watchForBatchQuestion(target.terminal.leafId);
        return {
          result: {
            ok: true,
            interrupted: true,
            clearedInput: false,
            terminal: target.terminal,
          },
        };
      }

      const input = sanitizeTerminalInput(params.text);
      if (!input.ok) return automationError("invalid_request", input.error);
      const target = await requireIdle(params, method === "terminal_execute");
      if (!target.ok) return target.response;
      const rawBefore = deps.getBuffer(target.terminal.leafId) ?? "";
      const stateBefore = deps.getSessionState(target.terminal.leafId);
      const cursor = output.checkpoint(target.terminal.terminalId, rawBefore);
      if (pastDeadline(deadline))
        return lateRequest(
          method === "terminal_insert" ? "insert the text" : "run the command",
        );
      if (method === "terminal_insert") {
        if (!deps.write(target.terminal.leafId, input.text)) {
          return automationError(
            "terminal_unavailable",
            "terminal stopped before input could be delivered",
          );
        }
        const initialFingerprint = bufferFingerprint(rawBefore);
        const deadline = Date.now() + INPUT_VISIBILITY_TIMEOUT_MS;
        let inputVisible = false;
        while (Date.now() < deadline) {
          const current = deps.getBuffer(target.terminal.leafId) ?? "";
          const changed = bufferFingerprint(current) !== initialFingerprint;
          // A wrapped line can reach the buffer with a line break in it.
          const visibleTail = current
            .slice(Math.max(0, current.length - input.text.length - 512))
            .replace(/\r?\n/g, "");
          if (changed && visibleTail.includes(input.text)) {
            inputVisible = true;
            break;
          }
          await new Promise((resolveDelay) =>
            setTimeout(resolveDelay, INPUT_VISIBILITY_POLL_MS),
          );
        }
        return {
          result: {
            ok: true,
            terminal: target.terminal,
            inserted: input.text,
            executed: false,
            inputVisible,
            inputPending:
              deps.getSessionState(target.terminal.leafId)?.inputPending ??
              false,
            cursor,
          },
        };
      }
      executionSequence += 1;
      const executionId = `terminal-execution:${target.terminal.tabId}:${target.terminal.leafId}:${executionSequence}`;
      const execution: ExecutionState = {
        executionId,
        terminalId: target.terminal.terminalId,
        workspace: target.terminal.workspace,
        terminal: target.terminal,
        baselineGeneration: stateBefore?.commandGeneration ?? 0,
        cursor,
        startedAt: Date.now(),
        usesOsc: shellSupportsOsc(stateBefore?.shell),
        initialFingerprint: bufferFingerprint(rawBefore),
        inputText: input.text,
        sawBusy: false,
        phase: "queued",
        interruptRequested: false,
        waitCount: 0,
        exitCode: null,
      };
      rememberExecution(execution);
      setTimeout(() => {
        void dispatchExecution(execution).catch((cause: unknown) => {
          failDispatch(
            execution,
            `Sending the command failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          );
        });
      }, DISPATCH_DELAY_MS);
      return {
        result: {
          ok: true,
          terminal: { ...target.terminal, status: "busy" },
          inserted: input.text,
          executed: true,
          executionId,
          phase: execution.phase,
          next: "Call terminal_wait with this executionId to receive completion, exitCode, and bounded output.",
        },
      };
    },
  };
}
