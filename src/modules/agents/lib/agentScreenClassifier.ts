export type AgentScreenState = "attention" | "ready" | "working" | null;

const ATTENTION_PATTERNS = [
  /press enter to confirm/i,
  /press enter to (?:continue|submit)/i,
  /esc dismiss/i,
  /enter\s*to\s*select/i,
  /type\s*something/i,
  /chat\s*about\s*this/i,
  /requires approval/i,
  /would you like to (?:run|make|proceed|allow)/i,
  /do you want to (?:proceed|allow|continue)/i,
  /needs? (?:your )?(?:approval|permission|input)/i,
  /permission request/i,
  /select enter submit/i,
  /allow .* to (?:run|fetch|edit|use)/i,
  /select login method/i,
];

// These markers are transient controls rendered by a live TUI. Several CLIs
// keep their input prompt mounted below the spinner, so position alone cannot
// decide that the newer-looking prompt means the turn has settled. Completed
// summaries such as "Thought for 12s" intentionally do not belong here.
const LIVE_WORKING_PATTERNS = [
  /esc(?:\s*to)?\s*interrup/i,
  /working \(\d+s/i,
  /(?:^|\n)\s*(?:[*•]\s*)?working\.{2,}/i,
  /(?:^|\n)\s*(?:running|searching|fetching|thinking|generating|loading|waiting)\.{0,3}/i,
  // Antigravity keeps its prompt mounted while this live task footer runs.
  /\d+ task\(s\).*\/tasks/i,
];

const WORKING_PATTERNS = [
  ...LIVE_WORKING_PATTERNS,
  /thought for \d+s/i,
  /(?:^|\n)\s*[*] working\b/i,
  /(?:^|\n)\s*[*] (?:build|plan|explore)\b/i,
];

function tail(value: string): string {
  return value.replace(/\u0000/g, "").slice(-16_000);
}

function lastPatternIndex(value: string, pattern: RegExp): number {
  const flags = pattern.flags.includes("g")
    ? pattern.flags
    : `${pattern.flags}g`;
  const matcher = new RegExp(pattern.source, flags);
  let last = -1;
  for (const match of value.matchAll(matcher)) last = match.index;
  return last;
}

function lastAnyIndex(value: string, patterns: readonly RegExp[]): number {
  return patterns.reduce(
    (last, pattern) => Math.max(last, lastPatternIndex(value, pattern)),
    -1,
  );
}

function normalizedAgent(agent: string): string {
  return agent.replace(/^custom:/, "").toLowerCase();
}

export function classifyAgentScreen(
  agent: string,
  buffer: string | null,
): AgentScreenState {
  if (!buffer) return null;
  const screen = tail(buffer);
  const agentKind = normalizedAgent(agent);
  const attentionAt = lastAnyIndex(screen, ATTENTION_PATTERNS);
  const workingAt = lastAnyIndex(screen, WORKING_PATTERNS);
  const liveWorkingAt = lastAnyIndex(screen, LIVE_WORKING_PATTERNS);
  const resolvedAttentionAt = lastAnyIndex(screen, [
    /user\s*answered/i,
    /permission\s+(?:granted|approved)/i,
    /selected\s+(?:option|answer)/i,
    /\? for shortcuts/i,
  ]);
  let readyAt = -1;
  let openCodeCompletionAt = -1;
  let settledAt = -1;

  switch (agentKind) {
    case "claude":
      if (/shortcuts|manual mode|Claude *Code/.test(screen)) {
        readyAt = lastPatternIndex(screen, /(?:\u276f|>)(?!\s*\d+\.)[^\n]*/u);
      }
      // Claude leaves the previous "esc to interrupt" row in scrollback after
      // returning to its prompt. A completed-turn summary after that row is
      // the reliable boundary between stale spinner text and live work.
      settledAt = lastPatternIndex(
        screen,
        /(?:baked|brewed|cooked|crunched|worked) for \d+s/i,
      );
      break;
    case "codex":
      if (/(?:gpt-|OpenAI Codex|\/model to change)/i.test(screen)) {
        readyAt = lastPatternIndex(screen, /(?:\u203a|>)(?!\s*\d+\.)[^\n]*/u);
      }
      settledAt = lastPatternIndex(screen, /worked for \d+s/i);
      break;
    case "agy":
    case "antigravity":
      if (/\? for shortcuts/i.test(screen)) {
        readyAt = screen.lastIndexOf(">");
      }
      settledAt = lastPatternIndex(screen, /\? for shortcuts/i);
      break;
    case "opencode":
      readyAt = Math.max(
        lastPatternIndex(screen, /ctrl\+p commands/i),
        lastPatternIndex(screen, /[·•]\s*(?:\d+m\s*)?\d+(?:\.\d+)?s\b/i),
      );
      openCodeCompletionAt = lastPatternIndex(
        screen,
        /(?:\u00b7|\u2022|\u00c2\u00b7|\u00e2\u20ac\u00a2)\s*(?:\d+m\s*)?\d+(?:\.\d+)?s\b/i,
      );
      settledAt = openCodeCompletionAt;
      break;
    case "pi":
      if (/(?:pi coding agent|for shortcuts|session)/i.test(screen)) {
        readyAt = screen.lastIndexOf(">");
      }
      break;
    case "grok":
      if (/grok/i.test(screen)) {
        readyAt = screen.lastIndexOf(">");
      }
      break;
    default:
      break;
  }
  if (
    attentionAt >= 0 &&
    attentionAt >= workingAt &&
    resolvedAttentionAt < attentionAt &&
    screen.length - attentionAt <= 2_400
  ) {
    return "attention";
  }
  if (attentionAt >= readyAt && attentionAt >= workingAt && attentionAt >= 0) {
    return "attention";
  }
  // A TUI repaint can erase or merge the final prompt glyph while leaving a
  // completed-turn summary intact. When that boundary is newer than every
  // working marker, stale spinner rows must not keep the agent busy forever.
  if (settledAt > workingAt) return "ready";
  // Claude keeps its input prompt mounted below live progress. In that layout
  // a fresh `Thought for ...` row is older on-screen than the prompt even
  // though the turn is still running. Claude always paints one of the settled
  // summaries above when a normal turn actually completes, so progress newer
  // than the last summary must win over the persistent prompt. Without this,
  // every repaint can alternate working -> finished and flood notifications.
  if (
    agentKind === "claude" &&
    workingAt > settledAt &&
    screen.length - workingAt <= 2_400
  ) {
    return "working";
  }
  if (
    liveWorkingAt > attentionAt &&
    liveWorkingAt > settledAt &&
    screen.length - liveWorkingAt <= 2_400
  ) {
    return "working";
  }
  if (workingAt > readyAt) return "working";
  return readyAt >= 0 ? "ready" : null;
}

export function isAgentScreenReady(
  agent: string,
  buffer: string | null,
): boolean {
  return classifyAgentScreen(agent, buffer) === "ready";
}
