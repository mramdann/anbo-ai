import { describe, expect, it } from "vitest";
import { agentScreens as screens } from "./agentScreen.fixtures";
import {
  classifyAgentScreen,
  classifyAgentTurn,
  isAgentScreenReady,
  readAgentScreen,
} from "./agentScreenClassifier";

type Screen = keyof typeof screens;
const text = (name: Screen) => screens[name].join("\n");
const rule = "─".repeat(80);

/** Swaps the transcript row above a real composer for new rows. */
function withTranscript(name: Screen, marker: RegExp, rows: string[]) {
  const source = [...screens[name]];
  const at = source.findIndex((row) => marker.test(row));
  if (at < 0) throw new Error(`${name} has no ${marker}`);
  source.splice(at, 0, ...rows);
  return source.join("\n");
}

describe("real screens, captured 2026-09-28", () => {
  it.each<[string, Screen, "attention" | "working" | "ready" | null]>([
    ["claude", "claudeTrust", "attention"],
    ["claude", "claudeIdleAuto", "ready"],
    ["claude", "claudeIdleBypass", "ready"],
    ["claude", "claudeThinking", "working"],
    ["claude", "claudeStreaming", "working"],
    ["claude", "claudeToolRunning", "working"],
    ["claude", "claudeFinishedShort", "ready"],
    ["claude", "claudeFinishedProse", "ready"],
    ["claude", "claudeCreateDialog", "attention"],
    ["claude", "claudeOverwriteDialog", "attention"],
    ["claude", "claudeQuestion", "attention"],
    ["claude", "claudePlanApproval", "attention"],
    ["claude", "claudeInterrupted", "ready"],
    ["claude", "claudeCleared", "ready"],
    ["claude", "claudeBackgroundShell", "ready"],
    ["claude", "claudeNarrowFinished", "ready"],
    ["claude", "claudeWideFinished", "ready"],
    ["codex", "codexTrust", "attention"],
    ["codex", "codexIdle", "ready"],
    ["codex", "codexWorking", "working"],
    ["codex", "codexFinishedShort", "ready"],
    ["codex", "codexUnknownCommand", "ready"],
    ["codex", "codexApproval", "attention"],
    ["codex", "codexInterrupted", "ready"],
    ["kimi", "kimiTrust", "attention"],
    ["kimi", "kimiIdle", "ready"],
    ["kimi", "kimiMoon", "working"],
    ["kimi", "kimiSpinner", "working"],
    ["kimi", "kimiApproval", "attention"],
    ["kimi", "kimiFinished", "ready"],
    ["kimi", "kimiInterrupted", "ready"],
    ["antigravity", "agyTrust", "attention"],
    ["antigravity", "agyIdle", "ready"],
    ["agy", "agyGenerating", "working"],
    ["antigravity", "agyApproval", "attention"],
    ["antigravity", "agyQuestion", "attention"],
    ["antigravity", "agyBackgroundTask", "ready"],
    ["antigravity", "agyInterrupted", "ready"],
    ["opencode", "opencodeIdle", "ready"],
    ["opencode", "opencodeWorking", "working"],
    ["opencode", "opencodeEscAgain", "working"],
    ["opencode", "opencodeFinished", "ready"],
    ["opencode", "opencodeInterrupted", "ready"],
    ["opencode", "opencodePermission", "attention"],
  ])("%s %s reads %s", (agent, name, state) => {
    expect(classifyAgentScreen(agent, text(name))).toBe(state);
    expect(classifyAgentScreen(agent, screens[name])).toBe(state);
  });

  it("does not take a menu or an autocomplete list the user opened for a prompt", () => {
    expect(classifyAgentScreen("codex", text("codexPermissionsMenu"))).not.toBe(
      "attention",
    );
    expect(
      classifyAgentScreen("antigravity", text("agyAutocomplete")),
    ).not.toBe("attention");
  });

  it("reads Antigravity's pause between a command and the model as idle for the observer to bridge", () => {
    // Measured 2.5 s in the capture; the observer holds a turn open 3.5 s.
    expect(classifyAgentScreen("antigravity", text("agyCommandGap"))).toBe(
      "ready",
    );
  });

  it("names work left running while the agent waits", () => {
    expect(readAgentScreen("claude", text("claudeBackgroundShell"))).toEqual({
      state: "ready",
      background: "1 shell",
      settling: false,
    });
    expect(
      readAgentScreen("antigravity", text("agyBackgroundTask")).background,
    ).toBe("1 task");
    expect(readAgentScreen("codex", text("codexInterrupted")).background).toBe(
      "1 background terminal",
    );
    expect(readAgentScreen("claude", text("claudeIdleBypass")).background).toBe(
      null,
    );
  });

  it("is the same reading for browser ownership", () => {
    expect(classifyAgentTurn("antigravity", text("agyBackgroundTask"))).toBe(
      "ready",
    );
    expect(isAgentScreenReady("claude", text("claudeIdleAuto"))).toBe(true);
    expect(isAgentScreenReady("claude", text("claudeThinking"))).toBe(false);
  });
});

describe("the transcript is output, not controls", () => {
  const prose = [
    "  This action requires approval and needs your input.",
    "  Press Enter to continue. Would you like to proceed?",
    "  Do you want to allow it to run? Allow the agent to use it.",
    "  △ Permission required · Run this command? · Question 1/2",
    "  esc to interrupt · Working (3s · esc to interrupt) · Generating...",
  ];

  // The answer goes where each CLI prints it: above its turn-end row when it
  // has one, otherwise straight above the composer.
  it.each<[string, Screen, RegExp]>([
    ["claude", "claudeFinishedShort", /Churned for 3s · done/],
    ["codex", "codexFinishedShort", /^\s*19:43\s*$/],
    ["kimi", "kimiIdle", /^\s*╭/],
    ["antigravity", "agyIdle", /^─{20,}$/],
    ["opencode", "opencodeFinished", /19\.5s/],
  ])(
    "%s stays ready under an answer that quotes dialogs and progress",
    (agent, name, marker) => {
      const screen = withTranscript(name, marker, prose);
      expect(classifyAgentScreen(agent, screen)).toBe("ready");
    },
  );

  it.each<[string, Screen, RegExp, string]>([
    [
      "claude",
      "claudeFinishedShort",
      /^─{20,}$/,
      "※ recap: taught the classifier to read esc to interrupt",
    ],
    [
      "codex",
      "codexFinishedShort",
      /Ask Codex to do anything/,
      "  Tip: press esc to interrupt a running turn",
    ],
  ])(
    "%s stays ready when a tip under the finished turn mentions the key",
    (agent, name, marker, row) => {
      expect(
        classifyAgentScreen(agent, withTranscript(name, marker, [row])),
      ).toBe("ready");
    },
  );

  it("ignores Claude progress left above the last finished turn", () => {
    const screen = [
      "Claude Code v2.1.241",
      "❯ production test",
      "✻ Churning… (3s · esc to interrupt)",
      "Thought for 6s",
      "ANBO_PROD_E2E_OK",
      "✻ Baked for 6s · done 9:14 PM",
      rule,
      "❯ ",
      rule,
      "  ⏸ manual mode on",
    ].join("\n");
    expect(classifyAgentScreen("claude", screen)).toBe("ready");
  });

  it("still reads compact Claude layouts that put esc to interrupt in the footer", () => {
    const screen = [
      "ClaudeCodev2.1.245",
      "❯ long running request",
      "Bash(powershell -Command Start-Sleep -Seconds 15)",
      "Unfurling… (12s · 32 tokens)",
      "❯ ",
      "bypasspermissionson (shift+tabtocycle) · esctointerrupt · ←1agent",
    ].join("\n");
    expect(classifyAgentScreen("claude", screen)).toBe("working");
  });

  it.each(["Loading...", "Loading…", "Waiting... (12s)", "  ⎿  Running…"])(
    "keeps a Claude tool progress row live: %s",
    (row) => {
      const screen = withTranscript("claudeIdleBypass", /^─{20,}$/, [row]);
      expect(classifyAgentScreen("claude", screen)).toBe("working");
    },
  );

  it.each([
    "loading/pendingUrl/committed URL",
    "running tests is the next step",
    "Loading... describes a progress indicator.",
    "waitingForReady is enabled",
  ])("does not read report prose as a Claude progress row: %s", (row) => {
    const screen = withTranscript("claudeIdleBypass", /^─{20,}$/, [`  ${row}`]);
    expect(classifyAgentScreen("claude", screen)).toBe("ready");
  });

  it("ignores a Codex status row left above the turn that ended", () => {
    const screen = [
      "OpenAI Codex",
      "• Working (3s • esc to interrupt)",
      "• answer",
      "  Worked for 2m 4s · 14:01",
      "› Ask Codex to do anything",
      "  gpt-5.6-sol high",
      "  ? for shortcuts",
    ].join("\n");
    expect(classifyAgentScreen("codex", screen)).toBe("ready");
  });

  it("reads Claude's compact header and bypass footer with no banner", () => {
    expect(
      classifyAgentScreen(
        "claude",
        "ClaudeCodev2.1.245\nag/gemini-pro-agent\n\u276f \nbypasspermissionson (shift+tabtocycle) \u00b7 \u2190foragents",
      ),
    ).toBe("ready");
    const bypass = [
      "  Verification. The tab was reloaded and the screenshot shows the change.",
      "✻ Brewed for 1m 39s · done 7:29 PM",
      rule,
      "❯",
      rule,
      "  Fable 5.1 Xhigh | ctx: [····] 0%",
      "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
    ];
    expect(classifyAgentScreen("claude", bypass.join("\n"))).toBe("ready");
    // Without the rules and the footer a prompt glyph is no evidence at all.
    expect(classifyAgentScreen("claude", "  some output\n❯")).toBeNull();
  });

  it("handles CRLF and a transcript longer than it reads", () => {
    const screen = [
      "old output\r\n".repeat(2_000),
      screens.claudeFinishedShort.join("\r\n"),
    ].join("");
    expect(classifyAgentScreen("claude", screen)).toBe("ready");
  });
});

describe("codex", () => {
  it("marks commentary with no turn-end row as unfinished, never as work", () => {
    expect(readAgentScreen("codex", text("codexCommentary"))).toMatchObject({
      state: "ready",
      settling: true,
    });
    expect(readAgentScreen("codex", text("codexFinishedShort"))).toMatchObject({
      state: "ready",
      settling: false,
    });
    // A mistyped slash command prints a "•" row with no turn at all.
    expect(readAgentScreen("codex", text("codexUnknownCommand")).state).toBe(
      "ready",
    );
  });

  it.each([
    "  Worked for 6m 49s · 14:01",
    "  19:43",
    "─ Worked for 6s ──────",
    "■ Conversation interrupted - tell the model what to do differently.",
  ])("recognises the turn-end row %s", (end) => {
    const screen = [
      "• The baseline is ready. I will open one background tab.",
      end,
      "› Ask Codex to do anything",
      "  gpt-6-astra xhigh",
    ].join("\n");
    expect(readAgentScreen("codex", screen).settling).toBe(false);
  });

  it.each([
    "The report says Worked for 12s",
    "    Worked for 12s",
    "> Worked for 12s",
  ])("does not take quoted text for a turn-end row: %s", (quote) => {
    const screen = `OpenAI Codex\n\u2022 Continuing the test\n${quote}\n\u203a `;
    expect(readAgentScreen("codex", screen).settling).toBe(true);
  });

  it("trusts an open rollout turn unless the screen already closed it", () => {
    expect(
      classifyAgentScreen("codex", text("codexCommentary"), "running"),
    ).toBe("working");
    expect(
      readAgentScreen("codex", text("codexCommentary"), "complete"),
    ).toMatchObject({ state: "ready", settling: false });
    // An interruption may never be recorded as finished in the rollout.
    expect(
      classifyAgentScreen("codex", text("codexInterrupted"), "running"),
    ).toBe("ready");
    expect(classifyAgentScreen("codex", text("codexApproval"), "running")).toBe(
      "attention",
    );
  });

  it.each([
    "This command requires approval\n1. Yes\nPress enter to confirm",
    "Would you like to make the following edits?\nEsc to cancel",
    "# Questions\n1. Continue\nselect enter submit esc dismiss",
    "Select login method:\n1. Google login",
  ])("reads a prompt under the composer row as attention: %s", (prompt) => {
    expect(classifyAgentScreen("codex", `gpt-5.6-sol\n› ${prompt}`)).toBe(
      "attention",
    );
  });
});

describe("antigravity", () => {
  it("keeps a turn handed to a subagent working", () => {
    const handedOff = [
      "  I have dispatched an agent with access to MCP browser tools.",
      "● Agent(mcp_browser_agent: Browser Agent) I'm focusing intently on to... · 6s",
      "─".repeat(40),
      ">",
      "─".repeat(40),
      "? for shortcuts                            Gemini 3.1 Pro · high · 1 subagent(s)",
    ].join("\n");
    expect(classifyAgentScreen("antigravity", handedOff)).toBe("working");
    expect(classifyAgentTurn("antigravity", handedOff)).toBe("working");
    expect(
      classifyAgentScreen(
        "antigravity",
        handedOff.replace(" · 1 subagent(s)", ""),
      ),
    ).toBe("ready");
  });

  it("drops a question once progress or the idle footer is drawn below it", () => {
    expect(
      classifyAgentScreen(
        "antigravity",
        "Question 1/1\nenter Select - esc Skip\nesc to cancel\n> Alpha\nWaiting...",
      ),
    ).toBe("working");
    expect(
      classifyAgentScreen(
        "antigravity",
        "Question 1/1\nenter Select - esc Skip\nesc to cancel\n> Alpha\n? for shortcuts\n>",
      ),
    ).toBe("ready");
  });

  it("reads a ruled prompt as idle while its footer is replaced by typing", () => {
    expect(
      classifyAgentScreen(
        "antigravity",
        ["Antigravity CLI", rule, "> Jawab sa", rule].join("\n"),
      ),
    ).toBe("ready");
  });
});

describe("opencode", () => {
  it("reads the interrupt hint when a narrow footer cuts it short", () => {
    expect(
      classifyAgentScreen(
        "opencode",
        "ctrl+p commands\nBuild - GPT-5.6 Sol\nspinner esc interrup",
      ),
    ).toBe("working");
  });

  it("finds its footer when the hints wrap onto two rows", () => {
    expect(
      classifyAgentScreen(
        "opencode",
        "  ▣  Build · Muse Spark · 19.5s\n  D:\\work\\demo    10.6K (1% ctrl+p\n  scratchpad    commands",
      ),
    ).toBe("ready");
  });
});

describe("other agents", () => {
  it.each([
    ["pi", "Pi Coding Agent\n? for shortcuts\n>"],
    ["grok", "Grok CLI\n>"],
  ])("keeps the %s reading it had", (agent, screen) => {
    expect(classifyAgentScreen(agent, screen)).toBe("ready");
  });

  it("does not guess the prompt of an unknown CLI", () => {
    expect(classifyAgentScreen("custom:qwen", "qwen\n> ")).toBeNull();
    expect(classifyAgentScreen("claude", null)).toBeNull();
    expect(classifyAgentScreen("claude", "")).toBeNull();
  });

  it("reads a custom launcher by its CLI", () => {
    expect(classifyAgentScreen("custom:claude", text("claudeThinking"))).toBe(
      "working",
    );
  });
});

describe("kimi screens", () => {
  // Copied from a real `kimi --auto` run inside Anbo (0.42.0), trimmed to the
  // rows that decide the state.
  const idle = [
    "PS D:anbo-ai> kimi --auto",
    "    Welcome to Kimi Code!",
    "    Run /login or /provider to get started.",
    "    Directory: D:anbo-ai",
    "    Session:",
    "    Model:     not set, run /login or /provider",
    "    Version:   0.42.0",
    "  No session yet - one will be created on your first message.",
    "  > ",
    "Never Ask  D:anbo-ai  main [+1881 -225]  ask Kimi to schedule tasks  context: 0%",
  ].join("\n");

  const trustPrompt = [
    "PS D:anbo-ai> kimi --auto",
    "Trust this folder?",
    "\u2191\u2193 navigate \u00b7 Enter select \u00b7 Esc exit",
    "",
    "D:anbo-ai",
    "Project MCP targets:",
    "  anbomcp (http): url=http://127.0.0.1:7331/mcp",
    "> Trust this folder",
    "  Don't trust",
  ].join("\n");

  it("reads the mounted composer as ready", () => {
    expect(classifyAgentScreen("kimi", idle)).toBe("ready");
  });

  it("does not call a transcript of the banner a live composer", () => {
    expect(classifyAgentScreen("kimi", "Directory: D:anbo-ai\nSession:")).toBe(
      null,
    );
  });

  it("holds the turn open while the trust chooser is up", () => {
    expect(classifyAgentScreen("kimi", trustPrompt)).toBe("attention");
  });
});

describe("kimi turns", () => {
  // Kimi 2.0.2 keeps the composer and status line mounted while it works, so
  // the only thing that says "busy" is the row above them.
  const working = [
    "  Done",
    "",
    "\u2726 run this exact command: Start-Sleep -Seconds 12",
    "",
    "\u2839 thinking\u2026",
    "",
    "  Note:",
    "  > ",
    "Never Ask  GLM-5.3 thinking: high  D:anbo-dev-localsandbox   context: 5% (39.1k/977k)",
  ].join("\n");

  it("stays working while the spinner runs under a mounted composer", () => {
    expect(classifyAgentScreen("kimi", working)).toBe("working");
  });

  it("settles once the spinner row is gone", () => {
    expect(
      classifyAgentScreen("kimi", working.replace("\u2839 thinking\u2026", "")),
    ).toBe("ready");
  });

  const betweenTools = (moon: string) =>
    [
      " \u25cf Used browser_open \u00b7 MCP/anbomcp-dev (https://www.amazon.com/s?k=usb+c+hub)",
      '   {"controlId":211,"durationMs":247,"ok":true,"placement":"visible-background\u2026',
      "",
      `  ${moon}`,
      " \u256d\u2500\u2500\u2500\u2500\u2500\u2500",
      " \u2502 >                                                  \u2502",
      " \u2570\u2500\u2500\u2500\u2500\u2500\u2500",
      " Ask When Needed  GLM-5.3 thinking: high  D:\\anbo-dev-local\\sandbox",
      "                                          context: 5% (41k/977k)",
    ].join("\n");

  it("stays working while a moon phase marks the gap between tool calls", () => {
    expect(
      classifyAgentScreen(
        "kimi",
        betweenTools("\u{1F316} \u00b7 Tip: /goal for multi-step work"),
      ),
    ).toBe("working");
    expect(classifyAgentScreen("kimi", betweenTools("\u{1F315}"))).toBe(
      "working",
    );
  });

  it("settles once the moon row is gone", () => {
    expect(classifyAgentScreen("kimi", betweenTools(""))).toBe("ready");
  });

  it("reads a moon in the transcript as text, not as a live row", () => {
    expect(
      classifyAgentScreen(
        "kimi",
        betweenTools("").replace(
          "Used browser_open",
          "Used \u{1F315} browser_open",
        ),
      ),
    ).toBe("ready");
  });

  it("stays working while a message waits behind the running turn", () => {
    const queued = [
      "\u25cf Used browser_get_text \u00b7 MCP/anbomcp-dev",
      "  { \u2026",
      "  Tip: /web: use the Web UI for a better experience",
      "\u276f take a snapshot of the current page and count how many links it has",
      "  \u2191 to edit \u00b7 ctrl-s to steer immediately",
      "  > ",
      "Never Ask  GLM-5.3 thinking: high  D:anbo-dev-localsandbox   context: 7%",
    ].join("\n");
    expect(classifyAgentScreen("kimi", queued)).toBe("working");
  });

  it("blocks on an approval the agent cannot answer for itself", () => {
    const approval = [
      "\u25cf Using browser_open \u00b7 MCP/anbomcp-dev (https://example.com)",
      "\u25b6 Approve mcp__anbomcp-dev__browser_open?",
      "  GET   https://example.com",
      "\u25b6 1. Approve once",
      "  2. Approve for this session",
      "  3. Reject",
      "  4. Reject with feedback",
      "\u2191/\u2193 select \u00b7 1/2/3/4 choose \u00b7 \u21b5 confirm",
      "GLM-5.3 thinking: high  D:\\anbo-dev-local\\sandbox   context: 4%",
    ].join("\n");
    expect(classifyAgentScreen("kimi", approval)).toBe("attention");
  });
});
