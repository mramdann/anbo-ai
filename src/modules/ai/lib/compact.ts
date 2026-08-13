import type { ModelMessage } from "ai";

const KEEP_TAIL = 24;
const ELISION_TEXT = "[elided to save context; see prior tool call]";
const BYTES_PER_TOKEN = 3;
const MIN_OUTPUT_RESERVE = 256;
const MAX_OUTPUT_RESERVE = 8_192;
const MAX_PART_BYTES = 16 * 1024;

type ToolPart = {
  type: string;
  toolName?: string;
  toolCallId?: string;
  text?: string;
  input?: unknown;
  output?: unknown;
  [key: string]: unknown;
};

export function serializedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export type ContextBudget = {
  contextTokens: number;
  outputTokens: number;
  inputBytes: number;
};

export function deriveContextBudget(contextLimit: number): ContextBudget {
  const contextTokens = Math.max(512, Math.floor(contextLimit));
  const outputTokens = Math.min(
    MAX_OUTPUT_RESERVE,
    Math.max(MIN_OUTPUT_RESERVE, Math.floor(contextTokens * 0.15)),
  );
  return {
    contextTokens,
    outputTokens,
    inputBytes: Math.max(768, (contextTokens - outputTokens) * BYTES_PER_TOKEN),
  };
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (serializedBytes(value) <= maxBytes) return value;
  const marker = "\n[content truncated to fit context]";
  let low = 0;
  let high = value.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (serializedBytes(value.slice(0, mid) + marker) <= maxBytes) low = mid;
    else high = mid - 1;
  }
  return value.slice(0, low) + marker;
}

export function fitSystemText(system: string, maxBytes: number): string {
  return truncateUtf8(system, Math.max(256, maxBytes));
}

function elideToolResult(part: ToolPart): { changed: boolean; part: ToolPart } {
  if (part.type !== "tool-result") return { changed: false, part };
  if (
    part.output &&
    typeof part.output === "object" &&
    (part.output as { __elided?: boolean }).__elided
  ) {
    return { changed: false, part };
  }
  return {
    changed: true,
    part: {
      ...part,
      output: { type: "text", value: ELISION_TEXT, __elided: true },
    },
  };
}

function pathOfInput(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const path = (input as { path?: unknown }).path;
  return typeof path === "string" && path.length > 0 ? path : null;
}

function collectMutationPaths(messages: ModelMessage[]): Set<string> {
  const paths = new Set<string>();
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content as ToolPart[]) {
      if (part.type !== "tool-call") continue;
      if (
        part.toolName === "edit" ||
        part.toolName === "multi_edit" ||
        part.toolName === "write_file" ||
        part.toolName === "create_directory"
      ) {
        const path = pathOfInput(part.input);
        if (path) paths.add(path);
      }
    }
  }
  return paths;
}

function collectLastReadIdxPerPath(
  messages: ModelMessage[],
): Map<string, number> {
  const lastIdx = new Map<string, number>();
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content as ToolPart[]) {
      if (part.type !== "tool-call" || part.toolName !== "read_file") continue;
      const path = pathOfInput(part.input);
      if (path) lastIdx.set(path, index);
    }
  }
  return lastIdx;
}

function dropSupersededReads(messages: ModelMessage[]): {
  out: ModelMessage[];
  touched: boolean;
} {
  const mutated = collectMutationPaths(messages);
  const lastReadIdx = collectLastReadIdxPerPath(messages);
  const callIdToPath = new Map<string, string>();
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content as ToolPart[]) {
      if (part.type !== "tool-call" || part.toolName !== "read_file") continue;
      const path = pathOfInput(part.input);
      if (path && part.toolCallId) callIdToPath.set(part.toolCallId, path);
    }
  }

  let touched = false;
  const out = messages.map((message, index): ModelMessage => {
    if (!Array.isArray(message.content)) return message;
    let local = false;
    const content = (message.content as ToolPart[]).map((part) => {
      if (part.type !== "tool-result" || !part.toolCallId) return part;
      const path = callIdToPath.get(part.toolCallId);
      if (!path) return part;
      const stale =
        mutated.has(path) ||
        (lastReadIdx.has(path) && (lastReadIdx.get(path) as number) > index);
      if (!stale) return part;
      const result = elideToolResult(part);
      if (result.changed) local = true;
      return result.part;
    });
    if (!local) return message;
    touched = true;
    return { ...message, content } as ModelMessage;
  });
  return { out, touched };
}

export type CompactResult = {
  messages: ModelMessage[];
  compacted: boolean;
  droppedCount: number;
};

export type CompactOptions = {
  historyBytes?: number;
  maxTurnBytes?: number;
};

export function compactModelMessages(
  messages: ModelMessage[],
  contextLimit: number,
): ModelMessage[] {
  return compactModelMessagesDetailed(messages, contextLimit).messages;
}

export function compactModelMessagesDetailed(
  messages: ModelMessage[],
  contextLimit: number,
  options: CompactOptions = {},
): CompactResult {
  let droppedCount = 0;
  let working = messages;
  let approxTokens = serializedBytes(working) / BYTES_PER_TOKEN;

  if (approxTokens >= 0.55 * contextLimit) {
    const result = dropSupersededReads(working);
    if (result.touched) {
      working = result.out;
      droppedCount += 1;
      approxTokens = serializedBytes(working) / BYTES_PER_TOKEN;
    }
  }

  if (approxTokens >= 0.7 * contextLimit) {
    const out = working.slice();
    const stopIdx = Math.max(0, out.length - KEEP_TAIL);
    for (let index = 0; index < stopIdx; index += 1) {
      if (out[index].role === "system") continue;
      if (!Array.isArray(out[index].content)) continue;
      let changed = false;
      const content = (out[index].content as ToolPart[]).map((part) => {
        const result = elideToolResult(part);
        if (result.changed) changed = true;
        return result.part;
      });
      if (changed) {
        out[index] = { ...out[index], content } as ModelMessage;
        droppedCount += 1;
        if (serializedBytes(out) / BYTES_PER_TOKEN < 0.6 * contextLimit) break;
      }
    }
    working = out;
  }

  if (options.historyBytes === undefined) {
    return {
      messages: working,
      compacted: droppedCount > 0,
      droppedCount,
    };
  }
  const historyBytes = Math.max(
    256,
    options.historyBytes,
  );
  const maxTurnBytes = Math.max(
    256,
    Math.min(historyBytes, options.maxTurnBytes ?? historyBytes / 2),
  );
  const fitted = hardFitHistory(working, historyBytes, maxTurnBytes);
  droppedCount += fitted.droppedCount;
  return {
    messages: fitted.messages,
    compacted: droppedCount > 0,
    droppedCount,
  };
}

function boundPart(part: ToolPart): ToolPart {
  if (part.type === "tool-result" && serializedBytes(part) > MAX_PART_BYTES) {
    return elideToolResult(part).part;
  }
  if (part.type === "tool-call" && serializedBytes(part) > MAX_PART_BYTES) {
    return { ...part, input: { __elided: true } };
  }
  if (typeof part.text === "string") {
    return { ...part, text: truncateUtf8(part.text, MAX_PART_BYTES) };
  }
  return part;
}

function boundMessage(message: ModelMessage, maxBytes: number): ModelMessage {
  if (typeof message.content === "string") {
    return {
      ...message,
      content: truncateUtf8(message.content, Math.min(MAX_PART_BYTES, maxBytes)),
    } as ModelMessage;
  }
  if (!Array.isArray(message.content)) return message;
  return {
    ...message,
    content: (message.content as ToolPart[]).map(boundPart),
  } as ModelMessage;
}

function splitTurns(messages: ModelMessage[]): ModelMessage[][] {
  const turns: ModelMessage[][] = [];
  for (const message of messages) {
    if (message.role === "user" || turns.length === 0) turns.push([]);
    turns[turns.length - 1].push(message);
  }
  return turns;
}

function hardFitHistory(
  messages: ModelMessage[],
  historyBytes: number,
  maxTurnBytes: number,
): { messages: ModelMessage[]; droppedCount: number } {
  const turns = splitTurns(messages).map((turn) =>
    turn.map((message) => boundMessage(message, maxTurnBytes)),
  );
  const selected: ModelMessage[][] = [];
  let usedBytes = 2;
  let droppedCount = 0;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    let turn = turns[index];
    if (serializedBytes(turn) > maxTurnBytes) {
      turn = turn.map((message) =>
        boundMessage(message, maxTurnBytes / turn.length),
      );
    }
    const turnBytes = serializedBytes(turn);
    if (usedBytes + turnBytes <= historyBytes) {
      selected.unshift(turn);
      usedBytes += turnBytes;
    } else {
      droppedCount += turn.length;
    }
  }
  let fitted = selected.flat();
  if (fitted.length === 0 && messages.length > 0) {
    const latestUser = [...messages]
      .reverse()
      .find((message) => message.role === "user");
    fitted = [
      boundMessage(
        latestUser ?? messages[messages.length - 1],
        Math.max(256, historyBytes - 128),
      ),
    ];
  }
  while (fitted.length > 1 && serializedBytes(fitted) > historyBytes) {
    fitted.shift();
    droppedCount += 1;
  }
  if (fitted.length === 1 && serializedBytes(fitted) > historyBytes) {
    fitted = [boundMessage(fitted[0], Math.max(256, historyBytes - 128))];
  }
  if (serializedBytes(fitted) > historyBytes) {
    fitted = [
      { role: "user", content: "[latest turn truncated to fit context]" },
    ];
    droppedCount += 1;
  }
  return { messages: fitted, droppedCount };
}
