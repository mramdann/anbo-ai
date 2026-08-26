import { describe, expect, it } from "vitest";
import {
  buildAgentLaunchCommand,
  buildAgentResumeCommand,
  buildAgentRestoreCommand,
  createAgentRestoreFallback,
  createAgentResumeStates,
  createManualAgentResumeState,
  normalizePersistedAgentResume,
  shouldPinAgentSession,
} from "./resume";

describe("agent resume commands", () => {
  it.each(["claude", "codex", "antigravity", "pi", "opencode"])(
    "pins discovered %s session ids",
    (agent) => {
      expect(shouldPinAgentSession(agent)).toBe(true);
    },
  );

  it("does not pin unsupported agent session ids", () => {
    expect(shouldPinAgentSession("grok")).toBe(false);
    expect(shouldPinAgentSession("custom:aider")).toBe(false);
  });

  it.each([
    ["claude", "claude"],
    ["codex", "codex"],
    ["antigravity", "agy"],
    ["opencode", "opencode"],
  ] as const)("adopts manually launched %s sessions", (agent, command) => {
    expect(createManualAgentResumeState(agent, 1234)).toEqual({
      agent,
      command,
      armed: false,
      discoveryStartedAt: 1234,
      relaunchOnRestore: true,
    });
  });

  it("does not adopt unrequested manual agent families", () => {
    expect(createManualAgentResumeState("pi", 1234)).toBeUndefined();
    expect(createManualAgentResumeState("grok", 1234)).toBeUndefined();
    expect(createManualAgentResumeState("custom:aider", 1234)).toBeUndefined();
  });

  it.each([
    ["claude", "claude", "claude --resume"],
    ["codex", "codex", "codex resume"],
    ["antigravity", "agy", "agy --conversation"],
    ["pi", "pi", "pi --session"],
  ] as const)(
    "launches %s unchanged and resumes only after its real session id is known",
    (agent, command, resume) => {
      const [state] = createAgentResumeStates(agent, command, 1);
      expect(state?.sessionId).toBeUndefined();
      expect(state?.armed).toBe(false);
      expect(state?.relaunchOnRestore).toBe(true);
      expect(buildAgentLaunchCommand(state, command)).toBe(command);
      if (!state) throw new Error("missing resume descriptor");
      expect(
        buildAgentResumeCommand({
          ...state,
          sessionId: "00000000-0000-4000-8000-000000000001",
        }),
      ).toBe(`${resume} 00000000-0000-4000-8000-000000000001`);
    },
  );

  it("does not invent session ids for parallel panes", () => {
    const states = createAgentResumeStates("claude", "claude --model opus", 2);
    expect(states.map((state) => state?.sessionId)).toEqual([
      undefined,
      undefined,
    ]);
  });

  it("restores a sessionless live agent with its original launch command", () => {
    expect(
      buildAgentRestoreCommand({
        agent: "claude",
        command: "claude --model opus",
        relaunchOnRestore: true,
      }),
    ).toBe("claude --model opus");
    expect(
      buildAgentRestoreCommand({ agent: "claude", command: "claude" }),
    ).toBeNull();
  });

  it("migrates a legacy agent tab with the built-in fresh command", () => {
    expect(createAgentRestoreFallback("antigravity")).toEqual({
      agent: "antigravity",
      command: "agy",
      armed: true,
      relaunchOnRestore: true,
      resumeOnStart: true,
    });
    expect(createAgentRestoreFallback("grok")).toBeUndefined();
    expect(createAgentRestoreFallback("custom:aider")).toBeUndefined();
  });

  it("does not claim unsupported or custom agents are resumable", () => {
    expect(createAgentResumeStates("grok", "grok", 1)).toEqual([undefined]);
    expect(createAgentResumeStates("custom:aider", "aider", 1)).toEqual([
      undefined,
    ]);
  });

  it("captures OpenCode after launch and resumes by the discovered session id", () => {
    const [pending] = createAgentResumeStates(
      "opencode",
      "opencode --model x/y",
      1,
    );
    expect(pending).toEqual(
      expect.objectContaining({
        agent: "opencode",
        armed: false,
        command: "opencode --model x/y",
        discoveryStartedAt: expect.any(Number),
      }),
    );
    expect(buildAgentLaunchCommand(pending, "opencode --model x/y")).toBe(
      "opencode --model x/y",
    );
    expect(
      buildAgentResumeCommand({
        agent: "opencode",
        command: "opencode --model x/y",
        sessionId: "ses_02f317323ffevFt1WEh49hRc0b",
      }),
    ).toBe("opencode --model x/y --session ses_02f317323ffevFt1WEh49hRc0b");
  });

  it("timestamps only pending Codex discovery", () => {
    const [pending] = createAgentResumeStates("codex", "codex", 1);
    expect(pending).toEqual(
      expect.objectContaining({
        agent: "codex",
        armed: false,
        command: "codex",
        discoveryStartedAt: expect.any(Number),
      }),
    );
  });

  it("does not rewrite commands that already select a session or chain a shell command", () => {
    expect(createAgentResumeStates("claude", "claude --continue", 1)).toEqual([
      undefined,
    ]);
    expect(createAgentResumeStates("antigravity", "prepare && agy", 1)).toEqual(
      [undefined],
    );
    expect(createAgentResumeStates("pi", "pi | tee log.txt", 1)).toEqual([
      undefined,
    ]);
    expect(createAgentResumeStates("pi", "prepare & pi", 1)).toEqual([
      undefined,
    ]);
    expect(
      createAgentResumeStates("antigravity", "agy --conversation old-id", 1),
    ).toEqual([undefined]);
    expect(
      createAgentResumeStates("opencode", "opencode --continue", 1),
    ).toEqual([undefined]);
    expect(createAgentResumeStates("codex", "codex resume old-id", 1)).toEqual([
      undefined,
    ]);
  });

  it("keeps ordinary Antigravity options resumable", () => {
    const [state] = createAgentResumeStates(
      "antigravity",
      "agy --model gemini-3.1-pro",
      1,
    );
    expect(buildAgentLaunchCommand(state, "agy --model gemini-3.1-pro")).toBe(
      "agy --model gemini-3.1-pro",
    );
  });

  it("does not override Antigravity's own resume or headless modes", () => {
    expect(createAgentResumeStates("antigravity", "agy -c", 1)).toEqual([
      undefined,
    ]);
    expect(
      createAgentResumeStates("antigravity", "agy --print hello", 1),
    ).toEqual([undefined]);
  });

  it("rejects non-interactive commands during creation and hydration", () => {
    expect(createAgentResumeStates("claude", "claude --print hi", 1)).toEqual([
      undefined,
    ]);
    expect(
      normalizePersistedAgentResume({
        agent: "opencode",
        command: "opencode run fix this",
        sessionId: "ses_test123",
      }),
    ).toBeUndefined();
    expect(createAgentResumeStates("codex", "codex exec fix this", 1)).toEqual([
      undefined,
    ]);
  });

  it("hydrates current Codex UUID v7 sessions", () => {
    expect(
      normalizePersistedAgentResume({
        agent: "codex",
        command: "codex --model gpt-5.6-sol",
        sessionId: "01a0068e-3c06-75c3-bfdd-89323e589767",
      }),
    ).toEqual({
      agent: "codex",
      command: "codex --model gpt-5.6-sol",
      sessionId: "01a0068e-3c06-75c3-bfdd-89323e589767",
    });
  });

  it("rejects corrupted persisted descriptors", () => {
    expect(
      normalizePersistedAgentResume({
        agent: "claude",
        command: "claude",
        sessionId: "not-a-uuid",
      }),
    ).toBeUndefined();
    expect(
      normalizePersistedAgentResume({ agent: "codex", command: "codex\nrm" }),
    ).toBeUndefined();
    expect(
      normalizePersistedAgentResume({
        agent: "opencode",
        command: "opencode",
        sessionId: "invalid",
      }),
    ).toBeUndefined();
  });
});
