import type {
  AgentPhase,
  AgentSession,
  AgentStatus,
} from "@/modules/agents/lib/types";
import { redactSensitive } from "@/modules/ai/lib/redact";
import type { SpaceMeta } from "@/modules/spaces/lib/store";
import type { Tab, TerminalTab } from "@/modules/tabs";
import type {
  AgentAutomationRequest,
  AgentAutomationResponse,
} from "./agentAutomationProtocol";
import { agentIdFor } from "./agentIdentity";
import { isAgentScreenReady } from "./agentScreenClassifier";

export type {
  AgentAutomationMethod,
  AgentAutomationRequest,
  AgentAutomationResponse,
} from "./agentAutomationProtocol";
export {
  AGENT_REQUEST_EVENT,
  AGENT_RESPONSE_EVENT,
} from "./agentAutomationProtocol";
export { agentIdFor } from "./agentIdentity";

const MAX_MESSAGE_CHARS = 8_000;
const MAX_OUTPUT_CHARS = 12_000;
const OUTPUT_HISTORY_CHARS = 64_000;
const MAX_DEDUPLICATION_KEYS = 100;
const MAX_TRACKED_AGENTS = 100;
const SUBMIT_DELAY_MS = 90;
const ANTIGRAVITY_SUBMIT_DELAY_MS = 750;
const INPUT_READY_TIMEOUT_MS = 8_000;
const INPUT_READY_POLL_MS = 25;
const TUI_READY_POLL_MS = 100;
const TUI_READY_STABLE_POLLS = 3;

export type AgentDescriptor = {
  agentId: string;
  name: string;
  cli: string;
  status: AgentStatus;
  phase: AgentPhase;
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
};

type ServiceDependencies = {
  getTabs: () => Tab[];
  getSpaces: () => SpaceMeta[];
  getSessions: () => Record<number, AgentSession>;
  getActiveTabId: () => number | null;
  getBuffer: (leafId: number) => string | null;
  write: (leafId: number, data: string) => boolean;
  spawn: (
    workspace: ResolvedWorkspace,
    agent: string,
  ) => AgentSpawnHandle | null;
  subscribeSessions: (
    listener: (
      sessions: Record<number, AgentSession>,
      previous: Record<number, AgentSession>,
    ) => void,
  ) => () => void;
};

type ResolvedWorkspace = { id: string; root: string };

type OutputState = {
  generation: number;
  snapshot: string;
  stream: string;
  base: number;
  total: number;
};

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
): AgentDescriptor[] {
  const tabsById = new Map(
    tabs
      .filter(
        (tab): tab is TerminalTab =>
          tab.kind === "terminal" && tab.spaceId === space.id && !tab.private,
      )
      .map((tab) => [tab.id, tab]),
  );
  return Object.values(sessions)
    .flatMap((session) => {
      const tab = tabsById.get(session.tabId);
      if (!tab || !tabHasLeaf(tab, session.leafId)) return [];
      return [
        {
          agentId: agentIdFor(session.name, session.agent, session.tabId),
          name: session.name,
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

export function isAgentTuiReady(cli: string, buffer: string | null): boolean {
  const normalizedCli = cli.replace(/^custom:/, "").toLowerCase();
  if (
    normalizedCli !== "codex" &&
    normalizedCli !== "claude" &&
    normalizedCli !== "antigravity" &&
    normalizedCli !== "agy" &&
    normalizedCli !== "opencode"
  ) {
    return true;
  }
  return isAgentScreenReady(normalizedCli, buffer);
}

export async function waitForAgentTuiReady(
  getBuffer: () => string | null,
  cli: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let stablePolls = 0;
  while (Date.now() < deadline) {
    if (isAgentTuiReady(cli, getBuffer())) {
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

export async function submitAgentMessage(
  write: (leafId: number, data: string) => boolean,
  getBuffer: (leafId: number) => string | null,
  leafId: number,
  message: string,
  verifyInput = false,
  submitDelayMs = SUBMIT_DELAY_MS,
  inputReadyTimeoutMs = INPUT_READY_TIMEOUT_MS,
): Promise<boolean> {
  const before = verifyInput ? getBuffer(leafId) : null;
  if (!write(leafId, message)) return false;
  if (verifyInput) {
    const compactEcho = (value: string) =>
      value
        .replace(
          /\x1b\[[0-9;>?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][AB012]|\x1b[78=>]|\x1bc|\x1b[NOP\]X^_]/g,
          "",
        )
        .replace(/[\s\u0000-\u001f\u007f]+/g, "");
    const needle = compactEcho(message).slice(-120);
    const deadline = Date.now() + inputReadyTimeoutMs;
    let observed = false;
    while (Date.now() < deadline) {
      await new Promise<void>((resolve) =>
        setTimeout(resolve, INPUT_READY_POLL_MS),
      );
      const current = getBuffer(leafId);
      if (
        current !== null &&
        current !== before &&
        compactEcho(current).includes(needle)
      ) {
        observed = true;
        break;
      }
    }
    if (!observed) {
      write(leafId, "\x03");
      return false;
    }
  } else {
    await new Promise<void>((resolve) => setTimeout(resolve, submitDelayMs));
  }
  return write(leafId, "\r");
}

function suffixPrefixOverlap(previous: string, current: string): number {
  const limit = Math.min(previous.length, current.length, 8_192);
  if (limit === 0) return 0;
  const prefix = current.slice(0, limit);
  const suffix = previous.slice(-limit);
  const combined = `${prefix}\u0000${suffix}`;
  const table = new Uint32Array(combined.length);
  for (let index = 1; index < combined.length; index += 1) {
    let candidate = table[index - 1];
    while (candidate > 0 && combined[index] !== combined[candidate]) {
      candidate = table[candidate - 1];
    }
    if (combined[index] === combined[candidate]) candidate += 1;
    table[index] = candidate;
  }
  return Math.min(table[table.length - 1], limit);
}

function cursorOf(state: OutputState, offset = state.total): string {
  return `v1:${state.generation}:${offset}`;
}

function parseCursor(
  cursor: string,
): { generation: number; offset: number } | null {
  const match = /^v1:(\d+):(\d+)$/.exec(cursor);
  if (!match) return null;
  const generation = Number(match[1]);
  const offset = Number(match[2]);
  return Number.isSafeInteger(generation) && Number.isSafeInteger(offset)
    ? { generation, offset }
    : null;
}

export class AgentOutputTracker {
  private readonly states = new Map<string, OutputState>();

  read(
    agentId: string,
    rawOutput: string,
    cursor: unknown,
    requestedMaxChars: unknown,
  ): AgentReadResult {
    const maxChars =
      typeof requestedMaxChars === "number" &&
      Number.isInteger(requestedMaxChars)
        ? Math.max(1, Math.min(MAX_OUTPUT_CHARS, requestedMaxChars))
        : 4_000;
    const current = redactSensitive(rawOutput).slice(-OUTPUT_HISTORY_CHARS);
    let state = this.states.get(agentId);
    let reset = false;
    if (!state) {
      state = {
        generation: 1,
        snapshot: current,
        stream: current,
        base: 0,
        total: current.length,
      };
      this.states.set(agentId, state);
      while (this.states.size > MAX_TRACKED_AGENTS) {
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
        reset = true;
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

    const parsed = typeof cursor === "string" ? parseCursor(cursor) : null;
    if (
      cursor !== undefined &&
      (!parsed ||
        parsed.generation !== state.generation ||
        parsed.offset < state.base ||
        parsed.offset > state.total)
    ) {
      reset = true;
    }

    const start =
      parsed && !reset
        ? parsed.offset
        : Math.max(state.base, state.total - maxChars);
    const available = state.stream.slice(start - state.base);
    const output = available.slice(0, maxChars);
    const nextOffset = start + output.length;
    return {
      output,
      cursor: cursorOf(state, nextOffset),
      truncated: nextOffset < state.total || start > state.base,
      reset,
    };
  }

  remove(agentId: string): void {
    this.states.delete(agentId);
  }
}

function error(code: string, message: string): AgentAutomationResponse {
  return { error: { code, message } };
}

function paramString(
  params: Record<string, unknown>,
  key: string,
): string | null {
  const value = params[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function createAgentAutomationService(deps: ServiceDependencies) {
  const output = new AgentOutputTracker();
  const sendQueues = new Map<string, Promise<AgentAutomationResponse>>();
  const sendAcknowledgements = new Map<
    string,
    { lastActivityAt: number; buffer: string | null }
  >();
  const messageIds = new Map<string, number>();
  const initialSpawnLeaves = new Set<number>();

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
          response: error("workspace_not_found", workspace.error),
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
    );
    return { ok: true, workspace: resolved.workspace, agents };
  };

  const resolveTarget = (
    params: Record<string, unknown>,
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
        response: error("invalid_request", "agentId is required"),
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
        legacyId === agentId
      );
    });
    if (!agent) {
      output.remove(agentId);
      sendAcknowledgements.delete(agentId);
      return {
        ok: false,
        response: error(
          "agent_not_found",
          `agent is not available in workspace: ${agentId}`,
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
    const initial = resolveTarget(params);
    if (!initial.ok) {
      return { matched: false, closed: true, agent: null };
    }
    const matchesDesired = (agent: AgentDescriptor) =>
      desired === "finished"
        ? agent.phase === "finished"
        : desired !== null &&
          (agent.status === desired ||
            (desired === "waiting" && agent.phase === "attention"));
    if (matchesDesired(initial.agent)) {
      return { matched: true, agent: initial.agent };
    }
    const initialStatus = initial.agent.status;
    const initialPhase = initial.agent.phase;
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
        const current = resolveTarget(params);
        if (!current.ok) {
          finish({ matched: false, closed: true, agent: null });
          return;
        }
        if (
          matchesDesired(current.agent) ||
          (!desired &&
            (current.agent.status !== initialStatus ||
              current.agent.phase !== initialPhase))
        ) {
          finish({ matched: true, agent: current.agent });
        }
      };
      const timer = setTimeout(() => {
        const current = resolveTarget(params);
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

  const waitForSpawn = (
    workspace: ResolvedWorkspace,
    leafId: number,
    timeoutMs: number,
  ): Promise<AgentDescriptor | null> =>
    new Promise((resolve) => {
      let settled = false;
      let unsubscribe = () => {};
      const inspect = () => {
        if (settled) return;
        const agent = collectWorkspaceAgents(
          deps.getTabs(),
          deps.getSessions(),
          workspace,
          deps.getActiveTabId(),
        ).find((candidate) => candidate.leafId === leafId);
        if (!agent) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        resolve(agent);
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        unsubscribe();
        resolve(null);
      }, timeoutMs);
      unsubscribe = deps.subscribeSessions(inspect);
      inspect();
    });

  const send = async (
    params: Record<string, unknown>,
  ): Promise<AgentAutomationResponse> => {
    let target = resolveTarget(params);
    if (!target.ok) return target.response;
    const message = sanitizeAgentMessage(params.message);
    if (!message.ok) return error("invalid_request", message.error);
    const sourceAgentId = paramString(params, "sourceAgentId");
    if (sourceAgentId === target.agent.agentId) {
      return error(
        "invalid_request",
        "an agent cannot send a message to itself",
      );
    }
    const messageId = paramString(params, "messageId");
    const deduplicationKey = messageId
      ? `${target.agent.agentId}:${messageId}`
      : null;
    if (deduplicationKey && messageIds.has(deduplicationKey)) {
      return error(
        "duplicate_message",
        `messageId was already sent: ${messageId}`,
      );
    }

    const waitForReady = params.waitForReady !== false;
    const timeout =
      typeof params.timeout === "number" && Number.isInteger(params.timeout)
        ? Math.max(100, Math.min(60_000, params.timeout))
        : 30_000;
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
        return error(
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
        return error(
          waited.closed ? "agent_not_found" : "timeout",
          waited.closed
            ? "agent closed while waiting to receive the message"
            : `timed out waiting for ${target.agent.name} to become ready`,
        );
      }
    }

    const current = resolveTarget(params);
    if (!current.ok) return current.response;
    if (!deps.getSessions()[current.leafId]) {
      return error("agent_not_found", "agent terminal is no longer available");
    }
    if (
      waitForReady &&
      (acceptsInitialSpawnMessage || current.agent.cli === "codex") &&
      !(await waitForAgentTuiReady(
        () => deps.getBuffer(current.leafId),
        current.agent.cli,
        timeout,
      ))
    ) {
      return error(
        "agent_not_ready",
        `${current.agent.name} did not reach a stable input prompt before timeout`,
      );
    }
    if (deduplicationKey) {
      messageIds.set(deduplicationKey, Date.now());
      while (messageIds.size > MAX_DEDUPLICATION_KEYS) {
        const oldest = messageIds.keys().next().value;
        if (oldest === undefined) break;
        messageIds.delete(oldest);
      }
    }
    const submitted = await submitAgentMessage(
      deps.write,
      deps.getBuffer,
      current.leafId,
      message.message,
      !isAntigravity &&
        (acceptsInitialSpawnMessage || normalizedCli === "codex"),
      isAntigravity ? ANTIGRAVITY_SUBMIT_DELAY_MS : SUBMIT_DELAY_MS,
      timeout,
    );
    if (!submitted) {
      return error(
        "agent_not_ready",
        `${current.agent.name} input cancelled`,
      );
    }
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
    return {
      result: {
        ok: true,
        agent: current.agent,
        sent: message.message,
        queued: target.agent.status !== "waiting",
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
          return error("invalid_request", "agent is required");
        }
        const spawned = deps.spawn(resolved.workspace, requestedAgent);
        if (!spawned) {
          return error(
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
            ? Math.max(100, Math.min(60_000, params.timeout))
            : 15_000;
        const agent = await waitForSpawn(
          resolved.workspace,
          spawned.leafId,
          timeout,
        );
        return {
          result: {
            ok: true,
            pending: agent === null,
            placement: "background",
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
        const resolved = resolveTarget(params);
        return !resolved.ok
          ? resolved.response
          : { result: { agent: resolved.agent } };
      }
      if (request.method === "agent_read") {
        const resolved = resolveTarget(params);
        if (!resolved.ok) return resolved.response;
        const raw = deps.getBuffer(resolved.leafId);
        if (raw === null) {
          return error(
            "agent_unavailable",
            "agent terminal buffer is not available",
          );
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
        if (!agentId) return error("invalid_request", "agentId is required");
        const previous = sendQueues.get(agentId);
        const pending = (
          previous ?? Promise.resolve<AgentAutomationResponse>({ result: null })
        )
          .catch(() => ({ result: null }))
          .then(() => send(params));
        sendQueues.set(agentId, pending);
        const result = await pending;
        if (sendQueues.get(agentId) === pending) sendQueues.delete(agentId);
        return result;
      }
      if (request.method === "agent_wait") {
        const target = resolveTarget(params);
        if (!target.ok) return target.response;
        const status =
          params.status === "working" ||
          params.status === "waiting" ||
          params.status === "finished"
            ? params.status
            : null;
        const timeout =
          typeof params.timeout === "number" && Number.isInteger(params.timeout)
            ? Math.max(100, Math.min(60_000, params.timeout))
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
      return error(
        "invalid_request",
        `unsupported agent method: ${request.method}`,
      );
    },
    dispose() {
      sendQueues.clear();
      sendAcknowledgements.clear();
      messageIds.clear();
      initialSpawnLeaves.clear();
    },
  };
}
