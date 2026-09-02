import { resolveAgentWorkspace } from "@/modules/agents/lib/agentAutomation";
import type {
  AgentAutomationResponse,
  TerminalAutomationMethod,
} from "@/modules/agents/lib/agentAutomationProtocol";
import type { AgentSession } from "@/modules/agents/lib/types";
import { redactSensitive } from "@/modules/ai/lib/redact";
import type { SpaceMeta } from "@/modules/spaces/lib/store";
import type { Tab, TerminalTab } from "@/modules/tabs";
import { findLeafCwd, leafIds } from "@/modules/terminal/lib/panes";
import type { TerminalSessionState } from "@/modules/terminal/lib/useTerminalSession";

const MAX_INPUT_CHARS = 8_000;
const MAX_TITLE_CHARS = 64;
const MAX_OUTPUT_CHARS = 12_000;
const OUTPUT_HISTORY_CHARS = 64_000;
const MAX_TRACKED_TERMINALS = 100;
const MAX_EXECUTIONS = 100;
const WAIT_POLL_MS = 75;
const DISPATCH_DELAY_MS = 200;
const INITIAL_PROMPT_SYNC_TIMEOUT_MS = 30_000;
const INITIAL_PROMPT_SYNC_POLL_MS = 25;
const INPUT_VISIBILITY_TIMEOUT_MS = 500;
const INPUT_VISIBILITY_POLL_MS = 25;

export type SharedTerminalDescriptor = {
  terminalId: string;
  title: string;
  tabId: number;
  leafId: number;
  spaceId: string;
  workspace: string;
  cwd: string;
  active: boolean;
  status: "idle" | "busy" | "starting" | "exited";
  shell: string;
  columns?: number;
  rows?: number;
};

export type TerminalAutomationDependencies = {
  getTabs: () => Tab[];
  getSpaces: () => SpaceMeta[];
  getSessions: () => Record<number, AgentSession>;
  getActiveTabId: () => number | null;
  getBuffer: (leafId: number) => string | null;
  getSessionState: (leafId: number) => TerminalSessionState | null;
  hasForegroundProcess: (leafId: number) => Promise<boolean>;
  prepare: (leafId: number) => boolean;
  open: (
    workspace: { id: string; root: string },
    title: string,
  ) => { tabId: number; leafId: number } | null;
  close: (tabId: number, leafId: number) => boolean;
  write: (leafId: number, data: string) => boolean;
  initialPromptSyncTimeoutMs?: number;
};

type OutputState = {
  generation: number;
  snapshot: string;
  stream: string;
  base: number;
  total: number;
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

type ExecutionPhase =
  | "queued"
  | "dispatched"
  | "running"
  | "completed"
  | "interrupted";

type CompletionReason = "exited" | "interrupted" | "closed" | "dispatch_failed";

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
  waitCount: number;
  dispatchedAt?: number;
  runningAt?: number;
  completedAt?: number;
  completionReason?: CompletionReason;
  exitCode: number | null;
  finalRead?: TerminalReadSnapshot;
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

function suffixPrefixOverlap(previous: string, current: string): number {
  const limit = Math.min(previous.length, current.length);
  for (let length = limit; length > 0; length -= 1) {
    if (previous.endsWith(current.slice(0, length))) return length;
  }
  return 0;
}

function parseTerminalCursor(
  cursor: unknown,
): { generation: number; offset: number } | null {
  if (typeof cursor !== "string") return null;
  const match = /^t1:(\d+):(\d+)$/.exec(cursor);
  if (!match) return null;
  const generation = Number(match[1]);
  const offset = Number(match[2]);
  return Number.isSafeInteger(generation) && Number.isSafeInteger(offset)
    ? { generation, offset }
    : null;
}

class TerminalOutputTracker {
  private readonly states = new Map<string, OutputState>();

  private update(
    id: string,
    rawOutput: string,
  ): {
    state: OutputState;
    repainted: boolean;
  } {
    const current = redactSensitive(rawOutput).slice(-OUTPUT_HISTORY_CHARS);
    let state = this.states.get(id);
    let repainted = false;
    if (!state) {
      state = {
        generation: 1,
        snapshot: current,
        stream: current,
        base: 0,
        total: current.length,
      };
      this.states.set(id, state);
      while (this.states.size > MAX_TRACKED_TERMINALS) {
        const oldest = this.states.keys().next().value;
        if (oldest === undefined) break;
        this.states.delete(oldest);
      }
    } else if (current !== state.snapshot) {
      const overlap = current.startsWith(state.snapshot)
        ? state.snapshot.length
        : suffixPrefixOverlap(state.snapshot, current);
      if (overlap === 0) {
        state.generation += 1;
        state.snapshot = current;
        state.stream = current;
        state.base = 0;
        state.total = current.length;
        repainted = true;
      } else {
        const appended = current.slice(overlap);
        state.snapshot = current;
        state.stream += appended;
        state.total += appended.length;
        if (state.stream.length > OUTPUT_HISTORY_CHARS) {
          const removed = state.stream.length - OUTPUT_HISTORY_CHARS;
          state.stream = state.stream.slice(removed);
          state.base += removed;
        }
      }
    }
    return { state, repainted };
  }

  checkpoint(id: string, rawOutput: string): string {
    const { state } = this.update(id, rawOutput);
    return `t1:${state.generation}:${state.total}`;
  }

  read(
    id: string,
    rawOutput: string,
    cursor: unknown,
    requestedMaxChars: unknown,
  ): TerminalReadSnapshot {
    const maxChars =
      typeof requestedMaxChars === "number" &&
      Number.isInteger(requestedMaxChars)
        ? Math.max(1, Math.min(MAX_OUTPUT_CHARS, requestedMaxChars))
        : 4_000;
    const { state, repainted } = this.update(id, rawOutput);
    const parsed = parseTerminalCursor(cursor);
    const cursorInvalid =
      cursor !== undefined &&
      (!parsed ||
        parsed.generation !== state.generation ||
        parsed.offset < state.base ||
        parsed.offset > state.total);
    const reset = repainted || cursorInvalid;
    const start =
      parsed && !reset
        ? parsed.offset
        : Math.max(state.base, state.total - maxChars);
    const available = state.stream.slice(start - state.base);
    const output = available.slice(0, maxChars);
    const nextOffset = start + output.length;
    const hasMore = nextOffset < state.total;
    return {
      output,
      cursor: `t1:${state.generation}:${nextOffset}`,
      truncated: hasMore,
      hasMore,
      historyTruncated: start > state.base,
      reset,
      replayed: reset && cursor !== undefined,
    };
  }

  remove(id: string): void {
    this.states.delete(id);
  }
}

function responseError(code: string, message: string): AgentAutomationResponse {
  return { error: { code, message } };
}

function paramString(
  params: Record<string, unknown>,
  key: string,
): string | null {
  const value = params[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function terminalId(tabId: number, leafId: number): string {
  return `terminal:${tabId}:${leafId}`;
}

function isAgentLeaf(
  sessions: Record<number, AgentSession>,
  tabId: number,
  leafId: number,
): boolean {
  return Object.values(sessions).some(
    (session) => session.tabId === tabId && session.leafId === leafId,
  );
}

function baseStatus(
  state: TerminalSessionState | null,
): SharedTerminalDescriptor["status"] {
  if (!state?.ready) return state?.shellExited ? "exited" : "starting";
  if (state.shellExited) return "exited";
  return state.commandRunning || state.blockMode !== "prompt" ? "busy" : "idle";
}

export async function collectSharedTerminals(
  deps: TerminalAutomationDependencies,
  space: { id: string; root: string },
  verifyForeground = true,
): Promise<SharedTerminalDescriptor[]> {
  const sessions = deps.getSessions();
  const activeTabId = deps.getActiveTabId();
  const candidates = deps
    .getTabs()
    .filter(
      (tab): tab is TerminalTab =>
        tab.kind === "terminal" &&
        tab.spaceId === space.id &&
        !tab.private &&
        !tab.agent,
    )
    .flatMap((tab) =>
      leafIds(tab.paneTree).flatMap((leafId) => {
        if (isAgentLeaf(sessions, tab.id, leafId)) return [];
        const state = deps.getSessionState(leafId);
        return [
          {
            terminalId: terminalId(tab.id, leafId),
            title: tab.title,
            tabId: tab.id,
            leafId,
            spaceId: space.id,
            workspace: space.root,
            cwd: findLeafCwd(tab.paneTree, leafId) ?? tab.cwd ?? space.root,
            active: tab.id === activeTabId && tab.activeLeafId === leafId,
            status: baseStatus(state),
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

export function createTerminalAutomationService(
  deps: TerminalAutomationDependencies,
) {
  const output = new TerminalOutputTracker();
  const executions = new Map<string, ExecutionState>();
  const openedTerminals = new Set<string>();
  let executionSequence = 0;

  const rememberExecution = (execution: ExecutionState) => {
    executions.set(execution.executionId, execution);
    while (executions.size > MAX_EXECUTIONS) {
      const oldest = executions.keys().next().value;
      if (oldest === undefined) break;
      executions.delete(oldest);
    }
  };

  const finishExecution = (
    execution: ExecutionState,
    reason: CompletionReason,
    exitCode: number | null,
  ) => {
    if (execution.phase === "completed" || execution.phase === "interrupted") {
      return;
    }
    execution.phase = reason === "interrupted" ? "interrupted" : "completed";
    execution.completionReason = reason;
    execution.exitCode = reason === "interrupted" ? 130 : exitCode;
    execution.completedAt = Date.now();
    if (reason === "closed") {
      execution.terminal = { ...execution.terminal, status: "exited" };
    }
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
    const targetGeneration = execution.baselineGeneration + 1;
    const completion = state.commandCompletions?.find(
      (candidate) => candidate.generation === targetGeneration,
    );
    if (completion || (state.commandGeneration ?? 0) >= targetGeneration) {
      finishExecution(
        execution,
        execution.interruptRequested ? "interrupted" : "exited",
        completion?.exitCode ?? null,
      );
      return true;
    }
    const shellBusy = state.commandRunning || state.blockMode !== "prompt";
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
    if (completed) {
      finishExecution(
        execution,
        execution.interruptRequested ? "interrupted" : "exited",
        null,
      );
    }
    return completed;
  };

  const synchronizeInitialPrompt = async (
    leafId: number,
    initialState: TerminalSessionState,
  ): Promise<TerminalSessionState | null> => {
    if (
      !shellSupportsOsc(initialState.shell) ||
      (initialState.commandGeneration ?? 0) > 0
    ) {
      return initialState;
    }
    const deadline =
      Date.now() +
      (deps.initialPromptSyncTimeoutMs ?? INITIAL_PROMPT_SYNC_TIMEOUT_MS);
    let state: TerminalSessionState | null = initialState;
    while (Date.now() < deadline) {
      await new Promise((resolveDelay) =>
        setTimeout(resolveDelay, INITIAL_PROMPT_SYNC_POLL_MS),
      );
      state = deps.getSessionState(leafId);
      if (!state || state.shellExited) return null;
      if ((state.commandGeneration ?? 0) > 0) return state;
    }
    return null;
  };

  const dispatchExecution = async (execution: ExecutionState) => {
    if (execution.phase !== "queued") return;
    const state = deps.getSessionState(execution.terminal.leafId);
    if (!state || state.shellExited) {
      finishExecution(execution, "closed", null);
      return;
    }
    if (
      !state.ready ||
      state.inputPending ||
      state.commandRunning ||
      state.blockMode !== "prompt" ||
      (await deps.hasForegroundProcess(execution.terminal.leafId))
    ) {
      if (execution.phase === "queued") {
        finishExecution(execution, "dispatch_failed", null);
      }
      return;
    }
    if (execution.phase !== "queued") return;
    if (!deps.prepare(execution.terminal.leafId)) {
      finishExecution(execution, "dispatch_failed", null);
      return;
    }
    const preparedState = deps.getSessionState(execution.terminal.leafId);
    const latestState = preparedState
      ? await synchronizeInitialPrompt(execution.terminal.leafId, preparedState)
      : null;
    if (
      !latestState?.ready ||
      latestState.shellExited ||
      latestState.inputPending ||
      latestState.commandRunning ||
      latestState.blockMode !== "prompt" ||
      (await deps.hasForegroundProcess(execution.terminal.leafId))
    ) {
      finishExecution(execution, "dispatch_failed", null);
      return;
    }
    const raw = deps.getBuffer(execution.terminal.leafId) ?? "";
    execution.baselineGeneration = latestState.commandGeneration ?? 0;
    execution.cursor = output.checkpoint(execution.terminalId, raw);
    execution.initialFingerprint = bufferFingerprint(raw);
    execution.usesOsc = shellSupportsOsc(latestState.shell);
    execution.phase = "dispatched";
    execution.dispatchedAt = Date.now();
    if (!deps.write(execution.terminal.leafId, `${execution.inputText}\r`)) {
      finishExecution(execution, "closed", null);
    }
  };

  const hasPendingExecution = async (id: string): Promise<boolean> => {
    for (const execution of executions.values()) {
      if (
        execution.terminalId === id &&
        !(await refreshExecutionCompletion(execution))
      ) {
        return true;
      }
    }
    return false;
  };

  const resolve = async (
    params: Record<string, unknown>,
    verifyForeground = true,
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
        response: responseError("workspace_not_found", workspace.error),
      };
    }
    return {
      ok: true,
      workspace: workspace.space,
      terminals: await collectSharedTerminals(
        deps,
        workspace.space,
        verifyForeground,
      ),
    };
  };

  const resolveTarget = async (
    params: Record<string, unknown>,
    verifyForeground = true,
  ) => {
    const resolved = await resolve(params, verifyForeground);
    if (!resolved.ok) return resolved;
    const id = paramString(params, "terminalId");
    if (!id) {
      return {
        ok: false as const,
        response: responseError("invalid_request", "terminalId is required"),
      };
    }
    const terminal = resolved.terminals.find(
      (candidate) => candidate.terminalId === id,
    );
    if (!terminal) {
      output.remove(id);
      return {
        ok: false as const,
        response: responseError(
          "terminal_not_found",
          `shared terminal is not available in workspace: ${id}`,
        ),
      };
    }
    return { ok: true as const, terminal };
  };

  const requireIdle = async (params: Record<string, unknown>) => {
    const target = await resolveTarget(params, false);
    if (!target.ok) return target;
    if (await hasPendingExecution(target.terminal.terminalId)) {
      return {
        ok: false as const,
        response: responseError(
          "terminal_busy",
          `${target.terminal.terminalId} is still observing a previously executed command`,
        ),
      };
    }
    if (target.terminal.status !== "idle") {
      return {
        ok: false as const,
        response: responseError(
          "terminal_busy",
          `${target.terminal.terminalId} is ${target.terminal.status}; wait for an idle shell prompt`,
        ),
      };
    }
    const latestState = deps.getSessionState(target.terminal.leafId);
    if (latestState?.inputPending) {
      return {
        ok: false as const,
        response: responseError(
          "terminal_input_pending",
          `${target.terminal.terminalId} contains unsubmitted input; submit or clear it before executing another command`,
        ),
      };
    }
    if (
      !latestState?.ready ||
      latestState.shellExited ||
      latestState.commandRunning ||
      latestState.blockMode !== "prompt" ||
      (await deps.hasForegroundProcess(target.terminal.leafId))
    ) {
      return {
        ok: false as const,
        response: responseError(
          "terminal_busy",
          `${target.terminal.terminalId} is no longer idle`,
        ),
      };
    }
    return target;
  };

  return {
    async handle(
      method: TerminalAutomationMethod,
      params: Record<string, unknown>,
    ): Promise<AgentAutomationResponse> {
      if (method === "terminal_open") {
        const workspace = resolveAgentWorkspace(
          deps.getSpaces(),
          params.workspace,
        );
        if (!workspace.ok) {
          return responseError("workspace_not_found", workspace.error);
        }
        const title = sanitizeTerminalTitle(params.title);
        if (!title.ok) return responseError("invalid_request", title.error);
        const opened = deps.open(workspace.space, title.title);
        if (!opened) {
          return responseError(
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
            placement: "background",
            terminal: {
              terminalId: id,
              title: title.title,
              tabId: opened.tabId,
              leafId: opened.leafId,
              spaceId: workspace.space.id,
              workspace: workspace.space.root,
              cwd: workspace.space.root,
              active: false,
              status: "starting",
              shell: "unknown",
            } satisfies SharedTerminalDescriptor,
          },
        };
      }

      if (method === "terminal_close") {
        const target = await resolveTarget(params, false);
        if (!target.ok) return target.response;
        const id = target.terminal.terminalId;
        if (!openedTerminals.has(id)) {
          return responseError(
            "terminal_not_owned",
            `${id} was not opened by terminal_open in this application session`,
          );
        }
        if (await hasPendingExecution(id)) {
          return responseError(
            "terminal_busy",
            `${id} is still observing a previously executed command`,
          );
        }
        const state = deps.getSessionState(target.terminal.leafId);
        if (state?.inputPending) {
          return responseError(
            "terminal_input_pending",
            `${id} contains unsubmitted input; submit or clear it before closing`,
          );
        }
        if (
          !state ||
          (!state.shellExited &&
            (!state.ready ||
              state.commandRunning ||
              state.blockMode !== "prompt" ||
              (await deps.hasForegroundProcess(target.terminal.leafId))))
        ) {
          return responseError(
            "terminal_busy",
            `${id} is starting or running a foreground process`,
          );
        }
        if (!deps.close(target.terminal.tabId, target.terminal.leafId)) {
          return responseError(
            "terminal_close_failed",
            `${id} could not be closed safely`,
          );
        }
        openedTerminals.delete(id);
        output.remove(id);
        for (const [executionId, execution] of executions) {
          if (execution.terminalId === id) executions.delete(executionId);
        }
        return {
          result: {
            ok: true,
            closed: true,
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
          },
        };
      }

      if (method === "terminal_read") {
        const target = await resolveTarget(params, false);
        if (!target.ok) return target.response;
        const raw = deps.getBuffer(target.terminal.leafId);
        if (raw === null) {
          return responseError(
            "terminal_unavailable",
            "terminal buffer is not available",
          );
        }
        return {
          result: {
            terminal: target.terminal,
            ...output.read(
              target.terminal.terminalId,
              raw,
              params.cursor,
              typeof params.maxChars === "number"
                ? Math.min(MAX_OUTPUT_CHARS, params.maxChars)
                : params.maxChars,
            ),
          },
        };
      }

      if (method === "terminal_wait") {
        const executionId = paramString(params, "executionId");
        if (!executionId) {
          return responseError("invalid_request", "executionId is required");
        }
        const requestedTerminalId = paramString(params, "terminalId");
        if (!requestedTerminalId) {
          return responseError("invalid_request", "terminalId is required");
        }
        const workspace = resolveAgentWorkspace(
          deps.getSpaces(),
          params.workspace,
        );
        if (!workspace.ok) {
          return responseError("workspace_not_found", workspace.error);
        }
        const execution = executions.get(executionId);
        if (
          !execution ||
          execution.terminalId !== requestedTerminalId ||
          execution.workspace !== workspace.space.root
        ) {
          return responseError(
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
            ? Math.max(100, Math.min(60_000, params.timeout))
            : 10_000;
        const deadline = Date.now() + timeout;
        let completed = completedBeforeWait;
        while (Date.now() < deadline) {
          if (await refreshExecutionCompletion(execution)) {
            completed = true;
            break;
          }
          const remaining = deadline - Date.now();
          if (remaining > 0) {
            await new Promise((resolveDelay) =>
              setTimeout(resolveDelay, Math.min(WAIT_POLL_MS, remaining)),
            );
          }
        }
        completed ||= execution.completedAt !== undefined;
        let raw = deps.getBuffer(execution.terminal.leafId) ?? "";
        let state = deps.getSessionState(execution.terminal.leafId);
        let read =
          execution.finalRead ??
          (target.ok
            ? output.read(
                execution.terminalId,
                raw,
                execution.cursor,
                params.maxChars,
              )
            : {
                output: "",
                cursor: execution.cursor,
                truncated: false,
                hasMore: false,
                historyTruncated: false,
                reset: false,
                replayed: false,
              });
        if (
          !execution.finalRead &&
          target.ok &&
          completed &&
          execution.dispatchedAt !== undefined &&
          execution.completionReason !== "closed" &&
          execution.completionReason !== "dispatch_failed" &&
          (read.reset ||
            !read.output.trim() ||
            !state?.ready ||
            (!state.shellExited &&
              (state.commandRunning || state.blockMode !== "prompt")))
        ) {
          let previousLength = read.output.length;
          let stableIdlePolls = 0;
          for (let attempt = 0; attempt < 12; attempt += 1) {
            await new Promise((resolveDelay) => setTimeout(resolveDelay, 75));
            raw = deps.getBuffer(execution.terminal.leafId) ?? "";
            const candidate = output.read(
              execution.terminalId,
              raw,
              execution.cursor,
              params.maxChars,
            );
            if (candidate.output.length > read.output.length) read = candidate;
            state = deps.getSessionState(execution.terminal.leafId);
            const shellIdle =
              !!state?.ready &&
              (state.shellExited ||
                (!state.commandRunning && state.blockMode === "prompt"));
            stableIdlePolls =
              shellIdle && read.output.length === previousLength
                ? stableIdlePolls + 1
                : 0;
            previousLength = read.output.length;
            if (stableIdlePolls >= 2) break;
          }
        }
        if (completed) {
          execution.finalRead ??= { ...read };
          read = execution.finalRead;
        }
        const refreshed = target.ok
          ? await resolveTarget(params, false)
          : target;
        return {
          result: {
            executionId,
            completed,
            timedOut: !completed && !state?.shellExited,
            phase: execution.phase,
            completionReason: execution.completionReason ?? null,
            interrupted: execution.completionReason === "interrupted",
            exitCode: completed ? execution.exitCode : null,
            durationMs:
              (execution.completedAt ?? Date.now()) - execution.startedAt,
            repeated: repeatedWait,
            terminal: refreshed.ok ? refreshed.terminal : execution.terminal,
            ...read,
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
          return responseError(
            "execution_not_found",
            `shared terminal execution is not available: ${requestedExecutionId}`,
          );
        }
        if (execution) await refreshExecutionCompletion(execution);
        if (execution?.completedAt !== undefined) {
          return {
            result: {
              ok: true,
              executionId: execution.executionId,
              phase: execution.phase,
              completionReason: execution.completionReason ?? null,
              interrupted: execution.completionReason === "interrupted",
              clearedInput: false,
              alreadyCompleted: true,
              terminal: target.terminal,
            },
          };
        }
        if (execution?.phase === "queued") {
          execution.interruptRequested = true;
          finishExecution(execution, "interrupted", 130);
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
        if (!state?.ready || state.shellExited) {
          return responseError(
            "terminal_unavailable",
            `${target.terminal.terminalId} has no live shell`,
          );
        }
        if (execution) {
          execution.interruptRequested = true;
          if (!deps.write(target.terminal.leafId, "\x03")) {
            finishExecution(execution, "closed", null);
            return responseError(
              "terminal_unavailable",
              "terminal stopped before the interrupt could be delivered",
            );
          }
          return {
            result: {
              ok: true,
              executionId: execution.executionId,
              phase: execution.phase,
              completionReason: null,
              interruptRequested: true,
              interrupted: true,
              clearedInput: false,
              terminal: target.terminal,
            },
          };
        }
        if (state.inputPending) {
          if (!deps.write(target.terminal.leafId, "\x03")) {
            return responseError(
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
          return responseError(
            "terminal_idle",
            `${target.terminal.terminalId} has no foreground command to interrupt`,
          );
        }
        if (!deps.write(target.terminal.leafId, "\x03")) {
          return responseError(
            "terminal_unavailable",
            "terminal stopped before the interrupt could be delivered",
          );
        }
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
      if (!input.ok) return responseError("invalid_request", input.error);
      const target = await requireIdle(params);
      if (!target.ok) return target.response;
      const rawBefore = deps.getBuffer(target.terminal.leafId) ?? "";
      const stateBefore = deps.getSessionState(target.terminal.leafId);
      const cursor = output.checkpoint(target.terminal.terminalId, rawBefore);
      if (method === "terminal_insert") {
        if (!deps.write(target.terminal.leafId, input.text)) {
          return responseError(
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
          const visibleTail = current.slice(
            Math.max(0, current.length - input.text.length - 512),
          );
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
        void dispatchExecution(execution).catch(() => {
          finishExecution(execution, "dispatch_failed", null);
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
          dispatched: false,
          next: "Call terminal_wait with this executionId to receive completion, exitCode, and bounded output.",
        },
      };
    },
  };
}
