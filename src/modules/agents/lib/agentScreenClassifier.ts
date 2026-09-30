export type AgentScreenState = "attention" | "ready" | "working" | null;

/** What the bottom of an agent's screen says, beyond the bare state. */
export type AgentScreenReading = {
  state: AgentScreenState;
  /** Work the agent left running while it waits, e.g. "1 shell". */
  background: string | null;
  /**
   * The screen looks idle, but the transcript ends mid-turn: Codex output
   * newer than its last turn-end row, or a Claude thinking summary with
   * nothing after it. An observer that already knows a turn is open waits
   * longer before calling it over; on its own this never reads as work.
   */
  settling: boolean;
};

/**
 * Evidence from outside the screen: Codex's rollout says whether its current
 * turn is still open.
 */
export type TurnEvidence = "running" | "complete" | null;

type Rows = readonly string[];

// An agent CLI is read from the bottom of its screen, row by row.
//
// Every CLI here keeps its live controls at the bottom: the composer, the
// footer under it, the progress row above it, and any prompt that blocks the
// turn. The transcript above them is output the agent wrote, and a dialog it
// quotes there must never read as one. Rows are the terminal's physical rows:
// Claude Code and OpenCode pad every row to the full width, the terminal marks
// the next row wrapped, and a buffer that joins wrapped rows glues a spinner
// onto the end of the prompt above it.
const SCAN_ROWS = 80;

function bottomRows(screen: string | Rows | null): Rows | null {
  if (screen === null) return null;
  const rows =
    typeof screen === "string"
      ? screen.replace(/\u0000/g, "").split(/\r?\n/)
      : screen;
  let end = rows.length;
  while (end > 0 && !rows[end - 1].trim()) end -= 1;
  return rows.slice(Math.max(0, end - SCAN_ROWS), end);
}

const last = (rows: Rows, n: number): Rows =>
  rows.slice(Math.max(0, rows.length - n));
const any = (rows: Rows, pattern: RegExp) =>
  rows.some((row) => pattern.test(row));

function lastIndex(rows: Rows, pattern: RegExp, from = 0): number {
  for (let index = rows.length - 1; index >= Math.max(0, from); index -= 1) {
    if (pattern.test(rows[index])) return index;
  }
  return -1;
}

const RULE = /─{8,}|━{8,}/;
const idle = (background: string | null = null): AgentScreenReading => ({
  state: "ready",
  background,
  settling: false,
});
const reading = (
  state: AgentScreenState,
  background: string | null = null,
  settling = false,
): AgentScreenReading => ({ state, background, settling });

function plural(count: string, noun: string): string {
  return `${count} ${noun}${count === "1" ? "" : "s"}`;
}

// ---------------------------------------------------------------- Claude Code
// Composer: the prompt row between two rules (2.1.28x) or next to one of
// Claude's footers (older builds). Work: the spinner row above it,
// "✶ Baking… (2s · thinking)", whose verb always ends in an ellipsis, unlike
// the "✻ Baked for 2s · done" summary left in the transcript. A dialog hides
// the composer and names its keys.
const CLAUDE_PROMPT = /^\s*│?\s*[❯>](?!\s*\d+\.)(?:\s|$)/;
const CLAUDE_FOOTER =
  /shift\+tab ?to ?cycle|(?:manual|plan|auto|default) mode on|accept edits on|bypass ?permissions ?on|\? for shortcuts|esc ?to ?interrupt/i;
const CLAUDE_BANNER = /Claude *Code/;
// "✶ Baking… (2s · thinking)"; older builds drop the glyph on some frames.
const CLAUDE_SPINNER =
  /^\s*(?:[·✢✳✶✻✽*]\s*\p{L}[^…\r\n]{0,60}…|\p{Lu}[\p{L}\p{M}'’-]{1,30}…(?:\s|\(|$))/u;
// A tool still running: "Running 1 shell command…", "Loading... (12s)".
const CLAUDE_TOOL_RUNNING =
  /^\s*(?:⎿\s+)?(?:Running|Loading|Waiting|Searching|Fetching|Reading|Thinking|Generating)\b[^\r\n]{0,80}?(?:…|\.{3})(?:\s*\([^)\r\n]{1,40}\))?\s*$/i;
const CLAUDE_INTERRUPT = /esc ?to ?interrupt/i;
// What a finished turn leaves in the transcript: "✻ Baked for 14s · done
// 12:55 AM" (older builds: "Baked for 6s") or an interruption. Live cues above
// the last one of these are left over from an earlier turn.
const CLAUDE_TURN_END =
  /^\s*(?:✻\s+)?(?!Thought\b)\p{L}[\p{L}\p{M}'’-]{1,40} for (?:\d{1,4}h )?(?:\d{1,4}m )?\d{1,4}(?:\.\d{1,3})?s(?:\s*·[^\r\n]*)?$|^\s*⎿\s+Interrupted\b/u;
const CLAUDE_THINKING_TAIL = /^\s*[∴✻]?\s*Thought for \d+s\b/;
// The key legend a dialog draws on its last rows; no composer footer says it.
const CLAUDE_DIALOG_KEYS =
  /Esc to cancel|Enter to confirm|Enter to select|↑\/↓ to navigate|Tab to amend|ctrl\+g to edit/i;
const CLAUDE_DIALOG =
  /ready to execute\. Would you like to proceed\?|Do you want to (?:proceed|make|create|overwrite|allow|continue)\b/i;
const CLAUDE_OPTION_CURSOR = /^\s*│?\s*❯\s*\d+\.\s/;
const CLAUDE_SHELLS = /·\s*(\d+) shells?\b/;

function claudeComposer(rows: Rows): number {
  const footed = any(last(rows, 6), CLAUDE_FOOTER);
  const banner = any(rows, CLAUDE_BANNER);
  for (
    let index = rows.length - 1;
    index >= Math.max(0, rows.length - 8);
    index -= 1
  ) {
    if (!CLAUDE_PROMPT.test(rows[index])) continue;
    const ruled =
      RULE.test(rows[index - 1] ?? "") || RULE.test(rows[index + 1] ?? "");
    if (ruled || footed || banner) return index;
  }
  return -1;
}

function readClaude(rows: Rows): AgentScreenReading {
  const shells = CLAUDE_SHELLS.exec(last(rows, 3).join("\n"));
  const background = shells ? plural(shells[1], "shell") : null;
  if (any(last(rows, 6), CLAUDE_DIALOG_KEYS)) {
    return reading("attention", background);
  }
  const composer = claudeComposer(rows);
  if (composer < 0) {
    const tail = last(rows, 14);
    if (any(tail, CLAUDE_DIALOG) || any(tail, CLAUDE_OPTION_CURSOR)) {
      return reading("attention", background);
    }
  }
  // The live area sits between the transcript and the composer's top rule,
  // below whatever the last finished turn left behind; the footer under the
  // composer carries "esc to interrupt" in compact layouts.
  const endAt = lastIndex(rows, CLAUDE_TURN_END);
  const liveEnd = composer < 0 ? rows.length : composer;
  const live = rows.slice(Math.max(0, endAt + 1, liveEnd - 12), liveEnd);
  const footer =
    composer < 0 ? [] : rows.slice(Math.max(composer + 1, endAt + 1));
  // Free text in the live area ("※ recap: …", tips) can mention the hint, so
  // only the footer is trusted to carry it on its own.
  if (
    any(live, CLAUDE_SPINNER) ||
    any(live, CLAUDE_TOOL_RUNNING) ||
    any(footer, CLAUDE_INTERRUPT)
  ) {
    return reading("working", background);
  }
  if (composer < 0) return reading(null, background);
  const above = rows
    .slice(0, composer)
    .filter((row) => row.trim() && !RULE.test(row));
  const settling = CLAUDE_THINKING_TAIL.test(above[above.length - 1] ?? "");
  return reading("ready", background, settling);
}

// ---------------------------------------------------------------------- Codex
// Composer: "› " above the model line and "? for shortcuts". Work: the status
// row "• Working (10s • esc to interrupt)". A turn ends with a row of its own:
// "Worked for 1m 22s · 14:01" after a long one, the bare time "13:56" after a
// short one (0.156+), "Worked for 6s" with rules in older builds, or
// "■ Conversation interrupted".
const CODEX_PROMPT = /^\s*›(?!\s*\d+\.)(?:\s|$)/;
// The status row itself, "• Working (10s • esc to interrupt)", not a tip that
// happens to mention the key.
const CODEX_LIVE =
  /^\s*(?:•\s+)?\S[^\r\n]{0,40}\(\d+[^)\r\n]{0,20}[•·]\s*esc to interrupt\)|^\s*•\s+Working\b/;
// The key legend a prompt draws on its last rows; the composer never says it.
const CODEX_DIALOG_KEYS =
  /Press enter to confirm|enter to confirm|enter continue|esc to cancel|esc quit|esc skip|esc dismiss|enter submit|Select login method/i;
const CODEX_DIALOG =
  /Would you like to|Allow .{1,80}\?|Do you trust|Trust this folder\?/i;
const CODEX_OPTION_CURSOR = /^\s*›\s*\d+\.\s/;
const CODEX_MENU = /esc back|enter select/;
// Transcript cells: the agent's "• …" and the user's own "› …" message.
const CODEX_ACTIVITY = /^\s{0,2}[•›]\s+\S/;
// 0.156 separates the time with "·", 0.159 with "•".
const CODEX_TURN_END =
  /^\s{0,2}(?:[─━-]+\s*)?Worked for (?:\d{1,4}h )?(?:\d{1,4}m )?\d{1,4}(?:\.\d{1,3})?s(?:\s*[·•]\s*\d{1,2}:\d{2}(?:\s*[AP]M)?)?\s*[─━-]*\s*$|^\s{0,2}\d{1,2}:\d{2}(?:\s*[AP]M)?\s*$|^\s{0,2}■\s+Conversation interrupted/i;
const CODEX_TERMINALS = /(\d+) background terminals? running/;

function readCodex(rows: Rows, evidence: TurnEvidence): AgentScreenReading {
  const terminals = CODEX_TERMINALS.exec(last(rows, 12).join("\n"));
  const background = terminals
    ? plural(terminals[1], "background terminal")
    : null;
  const tail = last(rows, 16);
  const menu = any(tail, CODEX_MENU);
  const composer = lastIndex(rows, CODEX_PROMPT, rows.length - 8);
  // A prompt hides the composer; a legend above a live composer is the
  // agent's own answer quoting one.
  const legendAt = lastIndex(rows, CODEX_DIALOG_KEYS, rows.length - 10);
  if (!menu && legendAt >= 0 && legendAt >= composer) {
    return reading("attention", background);
  }
  if (
    composer < 0 &&
    !menu &&
    (any(tail, CODEX_DIALOG) || any(tail, CODEX_OPTION_CURSOR))
  ) {
    return reading("attention", background);
  }
  // A status row above the last turn-end row belongs to an earlier turn.
  const endAt = lastIndex(rows, CODEX_TURN_END);
  if (any(rows.slice(Math.max(endAt + 1, rows.length - 12)), CODEX_LIVE)) {
    return reading("working", background);
  }
  // The composer row itself looks like a user message, so activity is read
  // from the transcript above it; a turn-end row counts wherever it is.
  const transcript = composer < 0 ? rows : rows.slice(0, composer);
  const unfinished = lastIndex(transcript, CODEX_ACTIVITY) > endAt;
  // An open rollout turn is work, unless the screen already closed it: an
  // interrupted turn may never be recorded as finished.
  if (evidence === "running" && unfinished) {
    return reading("working", background);
  }
  if (composer < 0) return reading(null, background);
  return reading("ready", background, evidence !== "complete" && unfinished);
}

// ----------------------------------------------------------------------- Kimi
// Composer: a box around "> " with the status line and its context meter under
// it. Work: a braille spinner ("⠧ Working…") or, between tool calls, a moon
// phase (2.0.2+) above the box, or a queued message offering to steer the turn
// still running. A trust or approval chooser replaces the box.
const KIMI_STATUS = /context:\s*\d+%/i;
const KIMI_BOX_PROMPT = /^\s*│\s*>/;
const KIMI_LIVE = /^\s*[⠀-⣿](?:\s|$)|^\s*[\u{1F311}-\u{1F318}](?:\s|$)/u;
const KIMI_QUEUED = /ctrl-s\s+to\s+steer/i;
const KIMI_DIALOG =
  /↑\s*\/?\s*↓\s*(?:navigate|select)|Trust this folder\?|Approve once|1\/2\/3\/4 choose/i;
const KIMI_BARE_PROMPT = /^\s*>(?:\s|$)/;

function readKimi(rows: Rows): AgentScreenReading {
  const tail = last(rows, 16);
  const box = lastIndex(rows, KIMI_BOX_PROMPT, rows.length - 8);
  if (box < 0 && any(tail, KIMI_DIALOG)) return reading("attention");
  const liveEnd = box < 0 ? rows.length : box;
  const live = rows.slice(Math.max(0, liveEnd - 12), liveEnd);
  if (any(live, KIMI_LIVE) || any(live, KIMI_QUEUED)) return reading("working");
  if (box >= 0) return idle();
  // Builds before the boxed composer: "> " over the status line.
  if (any(last(rows, 4), KIMI_STATUS) && any(last(rows, 8), KIMI_BARE_PROMPT)) {
    return idle();
  }
  if (
    any(rows, /Welcome to Kimi Code/i) &&
    any(last(rows, 6), KIMI_BARE_PROMPT)
  ) {
    return idle();
  }
  return reading(null);
}

// ---------------------------------------------------------------- Antigravity
// Composer: ">" between two rules, "? for shortcuts" under it. While the model
// runs, the footer says "esc to cancel" instead, over a braille row
// ("Generating...", "Loading..."). A command it left running in the background
// keeps a task count in the footer after the turn ends; a subagent it handed
// the work to is still that turn's work.
const AGY_FOOTER_IDLE = /^\s*\? for shortcuts/;
const AGY_FOOTER_BUSY = /^\s*esc to cancel/;
const AGY_LIVE =
  /^\s*(?:[⠀-⣿]\s+)?(?:Generating|Working|Loading|Waiting|Thinking|Signing in)\.\.\./;
const AGY_DIALOG =
  /↑\/↓ Navigate · (?:enter Confirm|tab Amend|enter Select)|enter Select\s*[·-]\s*esc Skip|Run this command\?|Question \d+\/\d+|Do you trust the contents|press enter to confirm/i;
const AGY_AUTOCOMPLETE = /tab Complete/;
const AGY_PROMPT = /^\s*>(?:\s|$)/;
const AGY_TASKS = /(\d+) task\(s\)/;
const AGY_SUBAGENTS = /\d+ subagent\(s\)/;

function readAntigravity(rows: Rows): AgentScreenReading {
  const footer = last(rows, 2);
  const tasks = AGY_TASKS.exec(footer.join("\n"));
  const background = tasks ? plural(tasks[1], "task") : null;
  const from = rows.length - 18;
  // Typing "/" opens a command list whose footer also says "esc to cancel";
  // there it closes the list and says nothing about work.
  const autocomplete = any(last(rows, 18), AGY_AUTOCOMPLETE);
  // A question stays on screen for a moment after it is answered; progress
  // or the idle footer drawn below it says the answer went through.
  const dialogAt = autocomplete ? -1 : lastIndex(rows, AGY_DIALOG, from);
  const liveAt = lastIndex(rows, AGY_LIVE, rows.length - 14);
  const idleAt = lastIndex(rows, AGY_FOOTER_IDLE, rows.length - 2);
  if (dialogAt >= 0 && dialogAt > liveAt && dialogAt > idleAt) {
    return reading("attention", background);
  }
  if (
    any(footer, AGY_SUBAGENTS) ||
    liveAt > idleAt ||
    (!autocomplete && any(footer, AGY_FOOTER_BUSY))
  ) {
    return reading("working", background);
  }
  if (idleAt >= 0) return idle(background);
  // While something is typed the footer is replaced; the ruled prompt stays.
  const prompt = lastIndex(rows, AGY_PROMPT, rows.length - 6);
  if (
    prompt > 0 &&
    RULE.test(rows[prompt - 1] ?? "") &&
    RULE.test(rows[prompt + 1] ?? "")
  ) {
    return idle(background);
  }
  return reading(null, background);
}

// ------------------------------------------------------------------- OpenCode
// A full-screen app: its input box (a "┃" border closed by a "╹▀▀▀" row) and
// the footer under it are always drawn. The footer lays its hints out in
// columns, so at some widths "ctrl+p" and "commands" land on different rows.
// A narrow footer cuts the hint short: "esc interrup".
const OPENCODE_LIVE = /esc (?:again to )?interrup/;
// The prompt's own option row and key legend, not its title, which an answer
// in the transcript above can quote.
const OPENCODE_DIALOG =
  /Allow once\s{2,}Allow always|⇆\s*select\s+enter confirm|select\s+enter submit\s+esc dismiss/i;
const OPENCODE_COMPOSER = /^\s*╹▀{8,}|ctrl\+p(?:\s|$)|tab agents/;
// The start screen centres the input box, so a tall terminal puts it twenty
// rows or more above the footer. Its bottom border is drawn nowhere else.
const OPENCODE_BOX_END = /^\s*╹▀{8,}/;

function readOpenCode(rows: Rows): AgentScreenReading {
  if (any(last(rows, 24), OPENCODE_DIALOG)) return reading("attention");
  if (any(last(rows, 6), OPENCODE_LIVE)) return reading("working");
  if (any(last(rows, 12), OPENCODE_COMPOSER) || any(rows, OPENCODE_BOX_END)) {
    return idle();
  }
  return reading(null);
}

// ------------------------------------------------------------------ Pi, Grok
// Not re-measured against current builds; they keep the reading they had.
const LEGACY_WORKING =
  /esc(?:\s*to)?\s*interrup|working \(\d+s|^[\t ]*(?:running|searching|fetching|thinking|generating|loading|waiting)(?:\.{3}|…)/im;
const LEGACY_ATTENTION =
  /press enter to confirm|requires approval|do you want to (?:proceed|allow|continue)|↑\s*\/?\s*↓\s*(?:navigate|select)/i;

function readLegacy(agent: "pi" | "grok", rows: Rows): AgentScreenReading {
  const tail = last(rows, 12);
  if (any(tail, LEGACY_ATTENTION)) return reading("attention");
  if (any(tail, LEGACY_WORKING)) return reading("working");
  const screen = rows.join("\n");
  const known =
    agent === "pi"
      ? /pi coding agent|for shortcuts|session/i.test(screen)
      : /grok/i.test(screen);
  return known && screen.includes(">") ? idle() : reading(null);
}

function normalizedAgent(agent: string): string {
  return agent.replace(/^custom:/, "").toLowerCase();
}

export function readAgentScreen(
  agent: string,
  screen: string | Rows | null,
  evidence: TurnEvidence = null,
): AgentScreenReading {
  const rows = bottomRows(screen);
  if (!rows || rows.length === 0) return reading(null);
  const kind = normalizedAgent(agent);
  switch (kind) {
    case "claude":
      return readClaude(rows);
    case "codex":
      return readCodex(rows, evidence);
    case "kimi":
      return readKimi(rows);
    case "agy":
    case "antigravity":
      return readAntigravity(rows);
    case "opencode":
      return readOpenCode(rows);
    case "pi":
    case "grok":
      return readLegacy(kind, rows);
    default:
      return reading(null);
  }
}

export function classifyAgentScreen(
  agent: string,
  screen: string | Rows | null,
  evidence: TurnEvidence = null,
): AgentScreenState {
  return readAgentScreen(agent, screen, evidence).state;
}

export function isAgentScreenReady(
  agent: string,
  screen: string | Rows | null,
  evidence: TurnEvidence = null,
): boolean {
  return classifyAgentScreen(agent, screen, evidence) === "ready";
}

/**
 * Browser ownership follows the model turn. The status reading already treats
 * Antigravity's background tasks as waiting and its subagents as work, so the
 * turn is the same reading.
 */
export const readAgentTurn = readAgentScreen;
export const classifyAgentTurn = classifyAgentScreen;
