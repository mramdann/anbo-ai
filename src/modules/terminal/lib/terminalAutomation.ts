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
const MAX_OUTPUT_CHARS = 12_000;
const OUTPUT_HISTORY_CHARS = 64_000;
const MAX_TRACKED_TERMINALS = 100;
const MAX_EXECUTIONS = 100;
const WAIT_POLL_MS = 75;

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
  write: (leafId: number, data: string) => boolean;
};

type OutputState = {
  generation: number;
  snapshot: string;
  stream: string;
  base: number;
  total: number;
};

type ExecutionState = {
  executionId: string;
  terminalId: string;
  workspace: string;
  baselineGeneration: number;
  cursor: string;
  startedAt: number;
  usesOsc: boolean;
  initialFingerprint: string;
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
  ) {
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

export function createTerminalAutomationService(
  deps: TerminalAutomationDependencies,
) {
  const output = new TerminalOutputTracker();
  const executions = new Map<string, ExecutionState>();
  let executionSequence = 0;

  const rememberExecution = (execution: ExecutionState) => {
    executions.set(execution.executionId, execution);
    while (executions.size > MAX_EXECUTIONS) {
      const oldest = executions.keys().next().value;
      if (oldest === undefined) break;
      executions.delete(oldest);
    }
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
      if (method === "terminal_list") {
        const resolved = await resolve(params);
        if (!resolved.ok) return resolved.response;
        return {
          result: {
            workspace: resolved.workspace.root,
            spaceId: resolved.workspace.id,
            terminals: resolved.terminals,
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
        const target = await resolveTarget(params, false);
        if (!target.ok) return target.response;
        const executionId = paramString(params, "executionId");
        if (!executionId) {
          return responseError("invalid_request", "executionId is required");
        }
        const execution = executions.get(executionId);
        if (
          !execution ||
          execution.terminalId !== target.terminal.terminalId ||
          execution.workspace !== target.terminal.workspace
        ) {
          return responseError(
            "execution_not_found",
            `shared terminal execution is not available: ${executionId}`,
          );
        }
        const timeout =
          typeof params.timeout === "number" && Number.isInteger(params.timeout)
            ? Math.max(100, Math.min(60_000, params.timeout))
            : 10_000;
        const deadline = Date.now() + timeout;
        let completed = false;
        let sawBusy = false;
        while (Date.now() < deadline) {
          const state = deps.getSessionState(target.terminal.leafId);
          if (!state || state.shellExited) break;
          if ((state.commandGeneration ?? 0) > execution.baselineGeneration) {
            completed = true;
            break;
          }
          if (!execution.usesOsc) {
            const foreground = await deps.hasForegroundProcess(
              target.terminal.leafId,
            );
            const busy =
              state.commandRunning ||
              state.blockMode !== "prompt" ||
              foreground;
            sawBusy ||= busy;
            const outputChanged =
              bufferFingerprint(
                deps.getBuffer(target.terminal.leafId) ?? "",
              ) !== execution.initialFingerprint;
            if (
              !busy &&
              (sawBusy ||
                (outputChanged && Date.now() - execution.startedAt >= 250))
            ) {
              completed = true;
              break;
            }
          }
          const remaining = deadline - Date.now();
          if (remaining > 0) {
            await new Promise((resolveDelay) =>
              setTimeout(resolveDelay, Math.min(WAIT_POLL_MS, remaining)),
            );
          }
        }
        const raw = deps.getBuffer(target.terminal.leafId) ?? "";
        const state = deps.getSessionState(target.terminal.leafId);
        const read = output.read(
          target.terminal.terminalId,
          raw,
          execution.cursor,
          params.maxChars,
        );
        if (completed || state?.shellExited) executions.delete(executionId);
        const refreshed = await resolveTarget(params, false);
        return {
          result: {
            executionId,
            completed,
            timedOut: !completed && !state?.shellExited,
            exitCode:
              completed && execution.usesOsc
                ? (state?.lastExitCode ?? null)
                : null,
            durationMs: Date.now() - execution.startedAt,
            terminal: refreshed.ok ? refreshed.terminal : target.terminal,
            ...read,
          },
        };
      }

      if (method === "terminal_interrupt") {
        const target = await resolveTarget(params, false);
        if (!target.ok) return target.response;
        const state = deps.getSessionState(target.terminal.leafId);
        if (!state?.ready || state.shellExited) {
          return responseError(
            "terminal_unavailable",
            `${target.terminal.terminalId} has no live shell`,
          );
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
      if (
        method === "terminal_execute" &&
        !deps.prepare(target.terminal.leafId)
      ) {
        return responseError(
          "terminal_unavailable",
          "terminal renderer could not be prepared for command tracking",
        );
      }
      const delivered = deps.write(
        target.terminal.leafId,
        method === "terminal_execute" ? `${input.text}\r` : input.text,
      );
      if (!delivered) {
        return responseError(
          "terminal_unavailable",
          "terminal stopped before input could be delivered",
        );
      }
      let executionId: string | undefined;
      if (method === "terminal_execute") {
        executionSequence += 1;
        executionId = `terminal-execution:${target.terminal.tabId}:${target.terminal.leafId}:${executionSequence}`;
        rememberExecution({
          executionId,
          terminalId: target.terminal.terminalId,
          workspace: target.terminal.workspace,
          baselineGeneration: stateBefore?.commandGeneration ?? 0,
          cursor: output.checkpoint(target.terminal.terminalId, rawBefore),
          startedAt: Date.now(),
          usesOsc: shellSupportsOsc(stateBefore?.shell),
          initialFingerprint: bufferFingerprint(rawBefore),
        });
      }
      return {
        result: {
          ok: true,
          terminal: target.terminal,
          inserted: input.text,
          executed: method === "terminal_execute",
          executionId,
          next: executionId
            ? "Call terminal_wait with this executionId to receive completion, exitCode, and bounded output."
            : undefined,
        },
      };
    },
  };
}
