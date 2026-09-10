import { describe, expect, it } from "vitest";
import {
  classifyAgentScreen,
  isAgentScreenReady,
} from "./agentScreenClassifier";

describe("classifyAgentScreen", () => {
  it("keeps Codex commentary-to-tool gaps working without a spinner", () => {
    const gap = [
      "OpenAI Codex",
      "\u2022 Called anbomcp-dev.browser_tabs({})",
      "  \u2514 tabs: []",
      "\u2022 The baseline is ready. I will open one background tab.",
      "\u203a Ask Codex to do anything",
      "gpt-6-astra xhigh",
    ].join("\n");
    expect(classifyAgentScreen("codex", gap)).toBe("working");
    expect(isAgentScreenReady("codex", gap)).toBe(false);
    expect(
      classifyAgentScreen(
        "codex",
        `${gap}\n\u2500 Worked for 6m 49s \u2500\u2500`,
      ),
    ).toBe("ready");
    expect(classifyAgentScreen("codex", `Worked for 5s\n${gap}`)).toBe(
      "working",
    );
  });

  it.each([
    "The report says Worked for 12s",
    "    Worked for 12s",
    "> Worked for 12s",
    "```text\nWorked for 12s\n```",
  ])("does not settle Codex on quoted completion: %s", (quote) => {
    expect(
      classifyAgentScreen(
        "codex",
        `OpenAI Codex\n\u2022 Continuing the test\n${quote}\n\u203a `,
      ),
    ).toBe("working");
  });

  it("settles an explicit Codex interruption but not the next active turn", () => {
    const interrupted =
      "OpenAI Codex\n\u2022 Running the check\n\u25a0 Conversation interrupted - tell the model what to do differently.\n\u203a ";
    expect(classifyAgentScreen("codex", interrupted)).toBe("ready");
    expect(
      classifyAgentScreen(
        "codex",
        `${interrupted}\n\u2022 Continuing now\n\u203a `,
      ),
    ).toBe("working");
  });

  it.each(["Saut\u00e9ed", "Saut\u0065\u0301ed", "Cogitated", "Ruminated"])(
    "settles Claude's structural %s summary after report prose",
    (verb) => {
      const screen = [
        "Claude Code",
        "Thought for 9s",
        "    loading/pendingUrl/committed URL terbedakan jelas.",
        `\u273b ${verb} for 13m 12s \u00b7 done 8:03 PM`,
        "recap: QA complete",
        "\u276f ",
        "bypass permissions on (shift+tab to cycle)",
      ].join("\n");
      expect(classifyAgentScreen("claude", screen)).toBe("ready");
    },
  );

  it.each([
    "loading/pendingUrl/committed URL",
    "running tests is the next step",
    "thinking about the design",
    "Loading... describes a progress indicator.",
    "waitingForReady is enabled",
  ])("does not classify report prose as live work: %s", (prose) => {
    expect(
      classifyAgentScreen("claude", `Claude Code\n  ${prose}\n\u276f `),
    ).toBe("ready");
  });

  it.each(["Loading...", "Loading\u2026", "Waiting... (12s)"])(
    "preserves a live standalone progress row: %s",
    (progress) => {
      expect(
        classifyAgentScreen("claude", `Claude Code\n${progress}\n\u276f `),
      ).toBe("working");
    },
  );

  it.each([
    "> \u273b Saut\u00e9ed for 13m 12s",
    "The report says Saut\u00e9ed for 13m 12s",
    "```text\n\u273b Saut\u00e9ed for 13m 12s\n```",
    "    \u273b Saut\u00e9ed for 13m 12s",
    "\u273b Thought for 12s",
    "Baked for 6s is a sample completion string",
  ])("does not settle Claude on quoted/progress text: %s", (quote) => {
    expect(
      classifyAgentScreen(
        "claude",
        `Claude Code\nesc to interrupt\n${quote}\n\u276f `,
      ),
    ).toBe("working");
  });

  it("keeps a newer live turn working after a structural summary", () => {
    expect(
      classifyAgentScreen(
        "claude",
        "Claude Code\n\u273b Saut\u00e9ed for 13m 12s\nThought for 2s\n\u276f \nesctointerrupt",
      ),
    ).toBe("working");
  });

  it("recognizes bounded multi-hour and wrapped completion rows", () => {
    expect(
      classifyAgentScreen(
        "claude",
        "Claude Code\nThought for 6s\n\u273b Ruminated for 1h 2m 3.5s\n  \u00b7 done 8:03 PM\n\u276f ",
      ),
    ).toBe("ready");
  });

  it("handles CRLF and a report longer than the retained screen tail", () => {
    const screen = [
      "Claude Code",
      "old output\n".repeat(2_000),
      "Thought for 6s",
      "    loading/pendingUrl/committed URL terbedakan jelas.",
      "\u273b Saut\u00e9ed for 13m 12s \u00b7 done 8:03 PM",
      "\u276f ",
    ].join("\r\n");
    expect(classifyAgentScreen("claude", screen)).toBe("ready");
  });

  it("keeps an approval request newer than completion in attention", () => {
    expect(
      classifyAgentScreen(
        "claude",
        "Claude Code\n\u273b Saut\u00e9ed for 13m 12s\nRequires approval\nPress enter to confirm",
      ),
    ).toBe("attention");
  });

  it.each([
    ["claude", "Claude Code\nmanual mode on · ? for shortcuts\n❯ "],
    ["codex", "OpenAI Codex\n› Ask Codex to do anything\ngpt-5.6-sol high"],
    ["antigravity", "Antigravity CLI\n>\n? for shortcuts"],
    ["agy", "Antigravity CLI\n>\n? for shortcuts"],
    ["opencode", "Build · GPT-5.6 Sol\n\nctrl+p commands"],
    ["pi", "Pi Coding Agent\n? for shortcuts\n>"],
    ["grok", "Grok CLI\n>"],
  ])("detects a ready %s screen", (agent, screen) => {
    expect(classifyAgentScreen(agent, screen)).toBe("ready");
    expect(isAgentScreenReady(agent, screen)).toBe(true);
  });

  it.each([
    "This command requires approval\n1. Yes\nPress enter to confirm",
    "Would you like to make the following edits?\nEsc to cancel",
    "# Questions\n1. Continue\nselect enter submit esc dismiss",
    "Select login method:\n1. Google login",
  ])("gives attention precedence for %s", (screen) => {
    expect(classifyAgentScreen("codex", `gpt-5.6-sol\n› ${screen}`)).toBe(
      "attention",
    );
  });

  it("detects active work and avoids guessing an unknown CLI prompt", () => {
    expect(
      classifyAgentScreen("claude", "Working (3s · esc to interrupt)"),
    ).toBe("working");
    expect(classifyAgentScreen("custom:qwen", "qwen\n> ")).toBeNull();
  });

  it("detects Claude when its compact TUI removes spaces from the header", () => {
    expect(
      classifyAgentScreen(
        "claude",
        "ClaudeCodev2.1.245\nag/gemini-pro-agent\n\u276f \nbypasspermissionson (shift+tabtocycle) \u00b7 \u2190foragents",
      ),
    ).toBe("ready");
  });

  it("keeps OpenCode working while its TUI spinner is repainting", () => {
    expect(
      classifyAgentScreen(
        "opencode",
        "ctrl+p commands\nBuild - GPT-5.6 Sol\nspinner esc interrup",
      ),
    ).toBe("working");
  });

  it("keeps OpenCode working when ctrl+p remains after the interrupt footer", () => {
    expect(
      classifyAgentScreen(
        "opencode",
        "Berita menarik terbaru\n+ Thought: Planning Indonesian news browsing ... 2.0s\nBuild · GPT-5.6 Sol\nesc interrupt 8.7K (2%) ctrl+p commands",
      ),
    ).toBe("working");
  });

  it("detects OpenCode completion when its resumed TUI omits the command hint", () => {
    expect(
      classifyAgentScreen(
        "opencode",
        "ctrl+p commands\nBuild - GPT-5.6 Sol\nesc interrup\nAlpha · 11.3s",
      ),
    ).toBe("ready");
  });

  it("treats Antigravity generation as work instead of an attention prompt", () => {
    expect(
      classifyAgentScreen(
        "antigravity",
        "Antigravity CLI\n> request\nesc to cancel\nGenerating...",
      ),
    ).toBe("working");
  });

  it("treats Antigravity Working plus esc-to-cancel as active work", () => {
    expect(
      classifyAgentScreen(
        "antigravity",
        "Antigravity CLI\n> carikan berita\nWorking...\n>\nesc to cancel\nGemini 3.7 Flash · high",
      ),
    ).toBe("working");
  });

  it("treats Antigravity Loading plus its mounted prompt as active work", () => {
    expect(
      classifyAgentScreen(
        "antigravity",
        [
          "Antigravity CLI",
          "> long running request",
          "Bash(powershell -Command Start-Sleep -Seconds 20)",
          "Perintah sedang berjalan di latar belakang.",
          "Loading...",
          ">",
          "esc to cancel",
          "Gemini 3.7 Flash · high",
        ].join("\n"),
      ),
    ).toBe("working");
  });

  it("keeps Antigravity working while its restored prompt shows a background task", () => {
    expect(
      classifyAgentScreen(
        "antigravity",
        [
          "Antigravity CLI",
          "> run a long command",
          'Bash(powershell -Command "Start-Sleep -Seconds 20")',
          "Perintah sedang dijalankan di latar belakang.",
          "────────────────────────────────────────",
          ">",
          "────────────────────────────────────────",
          '  ● [15:32:02] powershell -Command "Start-Sleep -Seconds 20" running',
          "────────────────────────────────────────",
          "? for shortcuts · Gemini 3.7 Flash · high · 1 task(s) · /tasks",
        ].join("\n"),
      ),
    ).toBe("working");
  });

  it("clears an Antigravity question after the selected answer starts processing", () => {
    expect(
      classifyAgentScreen(
        "antigravity",
        "Question 1/1\nenter Select - esc Skip\nesc to cancel\n> Alpha\nWaiting...",
      ),
    ).toBe("working");
  });

  it("recognizes the restored Antigravity shortcut bar after a question", () => {
    expect(
      classifyAgentScreen(
        "antigravity",
        "Question 1/1\nenter Select - esc Skip\nesc to cancel\n> Alpha\n? for shortcuts\n>",
      ),
    ).toBe("ready");
  });

  it("uses the newest screen state instead of stale scrollback text", () => {
    expect(
      classifyAgentScreen(
        "codex",
        "› old prompt\nThought for 12s\nanswer\n› \ngpt-5.6-sol high",
      ),
    ).toBe("ready");
    expect(
      classifyAgentScreen(
        "claude",
        "❯ old prompt\nWorking (3s · esc to interrupt)\nClaude Code",
      ),
    ).toBe("working");
  });

  it("settles Claude after a completed turn even when the interrupt row remains", () => {
    expect(
      classifyAgentScreen(
        "claude",
        [
          "Claude Code v2.1.241",
          "\u276f production test",
          "Churning... esc to interrupt",
          "Thought for 6s",
          "ANBO_PROD_E2E_OK",
          "Baked for 6s",
          "\u276f ",
          "manual mode on · ? for shortcuts",
        ].join("\n"),
      ),
    ).toBe("ready");
  });

  it("keeps Claude working when fresh thought progress is above its mounted prompt", () => {
    expect(
      classifyAgentScreen(
        "claude",
        [
          "Claude Code v2.1.241",
          "\u276f previous request",
          "answer",
          "Brewed for 4s",
          "\u276f long running request",
          "Thought for 6s",
          "Web Search(latest information)",
          "Thought for 9s",
          "\u276f ",
          "manual mode on Â· ? for shortcuts",
        ].join("\n"),
      ),
    ).toBe("working");
  });

  it("keeps compact Claude TUI progress footer working", () => {
    expect(
      classifyAgentScreen(
        "claude",
        [
          "ClaudeCodev2.1.245",
          "\u276f long running request",
          "Bash(powershell -Command Start-Sleep -Seconds 15)",
          "Unfurling\u2026 (12s · 32 tokens)",
          "\u276f ",
          "bypasspermissionson (shift+tabtocycle) · esctointerrupt · \u21901agent",
        ].join("\n"),
      ),
    ).toBe("working");
  });

  it("uses a newer completion boundary when repaint merges the final prompt", () => {
    expect(
      classifyAgentScreen(
        "claude",
        "Claude Code\n\u276f request\nesc to interrupt\nThought for 6s\nanswer\nCrunched for 4s\nmanual mode on · ? for shortcuts",
      ),
    ).toBe("ready");
  });

  it("settles a restored Claude screen with a multi-minute Churned summary", () => {
    expect(
      classifyAgentScreen(
        "claude",
        [
          "Claude Code v2.1.247",
          "\u276f inspect this workspace",
          "Thought for 6s",
          "final answer",
          "Churned for 1m 37s · done 1:01 PM",
          "\u276f ",
          "bypass permissions on · ? for shortcuts",
        ].join("\n"),
      ),
    ).toBe("ready");
  });

  it("settles a restored Codex screen with a multi-minute completion", () => {
    expect(
      classifyAgentScreen(
        "codex",
        "OpenAI Codex\nWorking (3s · esc to interrupt)\nanswer\nWorked for 2m 4.5s\n› \ngpt-5.6-sol high",
      ),
    ).toBe("ready");
  });

  it("settles Codex and Antigravity after their completion boundary", () => {
    expect(
      classifyAgentScreen(
        "codex",
        "OpenAI Codex\nWorking (3s · esc to interrupt)\nanswer\nWorked for 4s\n› \ngpt-5.6-sol high",
      ),
    ).toBe("ready");
    expect(
      classifyAgentScreen(
        "antigravity",
        "Antigravity CLI\n> request\nGenerating...\nanswer\n>\n? for shortcuts",
      ),
    ).toBe("ready");
  });

  it.each([
    [
      "codex",
      "OpenAI Codex\nâ€º Ask Codex to do anything\n• Working (3s · esc to interrupt)\nâ€º \ngpt-5.6-sol high",
    ],
    [
      "claude",
      "Claude Code\n❯ explain this repository\nWorking (5s · esc to interrupt)\n❯ \nmanual mode on · ? for shortcuts",
    ],
  ])(
    "keeps %s working when its persistent input prompt is below the live spinner",
    (agent, screen) => {
      expect(classifyAgentScreen(agent, screen)).toBe("working");
    },
  );
});

describe("kimi screens", () => {
  // Copied from a real `kimi --auto` run inside Anbo, trimmed to the rows that
  // decide the state.
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
    // Without the status line under it, the same welcome text is only output
    // someone pasted or scrolled past.
    expect(classifyAgentScreen("kimi", "Directory: D:anbo-ai\nSession:")).toBe(
      null,
    );
  });

  it("holds the turn open while the trust chooser is up", () => {
    // The folder prompt is the first thing a fresh workspace sees, and it
    // blocks everything behind it until someone answers.
    expect(classifyAgentScreen("kimi", trustPrompt)).toBe("attention");
  });
});

describe("kimi turns", () => {
  // Also copied from a real run: Kimi leaves the composer and status line
  // mounted while it works, so the only thing that says "busy" is the spinner
  // row above them.
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
});

describe("kimi queued input", () => {
  it("stays working while a message waits behind the running turn", () => {
    // Typing while Kimi is busy parks the message above the composer with an
    // offer to steer the run. The offer only exists while something is
    // running, and at that moment there is no spinner row on screen at all.
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
});

describe("kimi permission prompt", () => {
  it("blocks on an approval the agent cannot answer for itself", () => {
    // Kimi outside --auto asks before it runs an MCP tool. The turn stops
    // here until someone chooses, and its hint uses a different arrow shape
    // from the list chooser, which is why both are recognised.
    const approval = [
      "\u25cf Using browser_open \u00b7 MCP/anbomcp-dev (https://example.com)",
      "\u25b6 Approve mcp__anbomcp-dev__browser_open?",
      "  GET   https://example.com",
      "\u25b6 1. Approve once",
      "  2. Approve for this session",
      "  3. Reject",
      "  4. Reject with feedback",
      "\u2191/\u2193 select \u00b7 1/2/3/4 choose \u00b7 \u21b5 confirm",
      "GLM-5.3 thinking: high  D:\anbo-dev-local\sandbox   context: 4%",
    ].join("\n");
    expect(classifyAgentScreen("kimi", approval)).toBe("attention");
  });
});
