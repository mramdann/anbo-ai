import type {
  AgentPhase,
  AgentSession,
  AgentStatus,
} from "@/modules/agents/lib/types";
import type { SpaceMeta } from "@/modules/spaces/lib/store";
import type { Tab, TerminalTab } from "@/modules/tabs";
import {
  type AgentAutomationRequest,
  type AgentAutomationResponse,
  automationError,
  paramString,
} from "./agentAutomationProtocol";
import { agentIdFor } from "./agentIdentity";
import { readAgentScreen } from "./agentScreenClassifier";
import { codexTurnEvidence } from "./codexTurnEvidence";
import { OutputTracker } from "./outputTracker";

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
const MAX_DEDUPLICATION_KEYS = 100;
const MAX_TRACKED_AGENTS = 100;
const SUBMIT_DELAY_MS = 90;
const ANTIGRAVITY_SUBMIT_DELAY_MS = 750;
const INPUT_READY_TIMEOUT_MS = 8_000;
const INPUT_READY_POLL_MS = 25;
const INPUT_CHUNK_CHARS = 256;
const TUI_READY_POLL_MS = 100;
const TUI_READY_STABLE_POLLS = 3;
const SUBMIT_SETTLE_POLLS = 2;

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
  write: (leafId: number, data: string) => boolean;
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
 * into the box as a newline, leaving the message typed but never sent. Both
 * are cheap to wait for -- the echo says when the text landed, and a settled
 * screen says when it is safe to press Enter.
 */
function needsEchoedInput(cli: string): boolean {
  return cli === "codex" || cli === "kimi";
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

export async function submitAgentMessage(
  write: (leafId: number, data: string) => boolean,
  getBuffer: (leafId: number) => string | null,
  leafId: number,
  message: string,
  verifyInput = false,
  submitDelayMs = SUBMIT_DELAY_MS,
  inputReadyTimeoutMs = INPUT_READY_TIMEOUT_MS,
): Promise<boolean> {
  if (verifyInput) {
    const compactEcho = (value: string) =>
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
        .replace(/[\s\u0000-\u001f\u007f\u2500-\u259f]+/g, "");
    const deadline = Date.now() + inputReadyTimeoutMs;
    // Keep each paste below TUI collapse thresholds so acknowledgement uses
    // actual echoed text, never an unverified "Pasted text" placeholder.
    for (let offset = 0; offset < message.length; ) {
      if (Date.now() >= deadline) {
        if (offset > 0) write(leafId, "\x03");
        return false;
      }
      let end = Math.min(offset + INPUT_CHUNK_CHARS, message.length);
      const last = message.charCodeAt(end - 1);
      if (end < message.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
      const before = getBuffer(leafId);
      if (!write(leafId, message.slice(offset, end))) {
        if (offset > 0) write(leafId, "\x03");
        return false;
      }
      const needle = compactEcho(message.slice(0, end)).slice(-120);
      let observed = false;
      while (Date.now() < deadline) {
        await new Promise<void>((resolve) =>
          setTimeout(resolve, INPUT_READY_POLL_MS),
        );
        const current = getBuffer(leafId);
        if (
          needle &&
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
      offset = end;
    }
    // Enter is only a send once the paste it follows has landed. A message
    // long enough to be written in more than one piece arrives as a burst,
    // and a carriage return caught inside that burst reads as a newline in
    // the input box rather than a submit -- the message then sits there,
    // typed but never sent. Let the prompt go quiet first, then press Enter
    // on a settled screen.
    await waitForQuietBuffer(getBuffer, leafId, deadline);
    await new Promise<void>((resolve) => setTimeout(resolve, submitDelayMs));
  } else {
    if (!write(leafId, message)) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, submitDelayMs));
  }
  return write(leafId, "\r");
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
      return automationError(
        "agent_not_ready",
        `${current.agent.name} terminal is not attached`,
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
      return automationError(
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
      readPreparedBuffer,
      current.leafId,
      message.message,
      !isAntigravity &&
        (acceptsInitialSpawnMessage ||
          needsEchoedInput(normalizedCli) ||
          message.message.length > INPUT_CHUNK_CHARS),
      isAntigravity ? ANTIGRAVITY_SUBMIT_DELAY_MS : SUBMIT_DELAY_MS,
      timeout,
    );
    if (!submitted) {
      return automationError(
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
          return automationError(
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
        if (!agentId)
          return automationError("invalid_request", "agentId is required");
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
      return automationError(
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
