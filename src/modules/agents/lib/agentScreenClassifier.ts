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

const WORKING_PATTERNS = [
  /esc to interrupt/i,
  /esc\s+interrup/i,
  /working \(\d+s/i,
  /(?:^|\n)\s*(?:[*•]\s*)?working\.{2,}/i,
  /thought for \d+s/i,
  /(?:^|\n)\s*[*] working\b/i,
  /(?:^|\n)\s*[*] (?:build|plan|explore)\b/i,
  /(?:^|\n)\s*(?:running|searching|fetching|thinking)\.{3}/i,
  /generating\.{0,3}/i,
  /waiting\.{0,3}/i,
];

// These markers are transient controls rendered by a live TUI. Several CLIs
// keep their input prompt mounted below the spinner, so position alone cannot
// decide that the newer-looking prompt means the turn has settled. Completed
// summaries such as "Thought for 12s" intentionally do not belong here.
const LIVE_WORKING_PATTERNS = [
  /esc to interrupt/i,
  /esc\s+interrup/i,
  /working \(\d+s[^\n]*(?:interrupt|esc)/i,
  /(?:^|\n)\s*(?:[*•]\s*)?working\.{2,}/i,
  /(?:^|\n)\s*(?:running|searching|fetching|thinking)\.{3}/i,
  /generating\.{0,3}/i,
  /waiting\.{0,3}/i,
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
  const normalized = agent.replace(/^custom:/, "").toLowerCase();
  return normalized === "agy" ? "antigravity" : normalized;
}

export function classifyAgentScreen(
  agent: string,
  buffer: string | null,
): AgentScreenState {
  if (!buffer) return null;
  const screen = tail(buffer);
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

  switch (normalizedAgent(agent)) {
    case "claude":
      if (/(?:shortcuts|manual mode|Claude Code)/i.test(screen)) {
        readyAt = lastPatternIndex(screen, /(?:\u276f|>)(?!\s*\d+\.)[^\n]*/u);
      }
      break;
    case "codex":
      if (/(?:gpt-|OpenAI Codex|\/model to change)/i.test(screen)) {
        readyAt = lastPatternIndex(screen, /(?:\u203a|>)(?!\s*\d+\.)[^\n]*/u);
      }
      break;
    case "antigravity":
      if (/\? for shortcuts/i.test(screen)) {
        readyAt = screen.lastIndexOf(">");
      }
      break;
    case "opencode":
      readyAt = Math.max(
        lastPatternIndex(screen, /ctrl\+p commands/i),
        lastPatternIndex(
          screen,
          /[·•]\s*(?:\d+m\s*)?\d+(?:\.\d+)?s\b/i,
        ),
      );
      openCodeCompletionAt = lastPatternIndex(
        screen,
        /(?:\u00b7|\u2022|\u00c2\u00b7|\u00e2\u20ac\u00a2)\s*(?:\d+m\s*)?\d+(?:\.\d+)?s\b/i,
      );
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
  if (
    liveWorkingAt >= 0 &&
    liveWorkingAt > attentionAt &&
    (normalizedAgent(agent) !== "opencode" ||
      liveWorkingAt > openCodeCompletionAt) &&
    screen.length - liveWorkingAt <= 2_400
  ) {
    return "working";
  }
  if (workingAt > readyAt && workingAt >= 0) return "working";
  return readyAt >= 0 ? "ready" : null;
}

export function isAgentScreenReady(
  agent: string,
  buffer: string | null,
): boolean {
  return classifyAgentScreen(agent, buffer) === "ready";
}
