import { describe, expect, it } from "vitest";
import {
  classifyAgentScreen,
  isAgentScreenReady,
} from "./agentScreenClassifier";

describe("classifyAgentScreen", () => {
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

  it("keeps compact Claude TUI progress with Unicode ellipsis working", () => {
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
