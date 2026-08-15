import { describe, expect, it } from "vitest";
import {
  buildAgentLaunchCommand,
  buildAgentResumeCommand,
  createAgentResumeStates,
  normalizePersistedAgentResume,
} from "./resume";

describe("agent resume commands", () => {
  it.each([
    ["claude", "claude --resume"],
    ["gemini", "gemini --resume"],
    ["pi", "pi --session"],
  ] as const)(
    "launches %s unchanged and resumes only after its real session id is known",
    (agent, resume) => {
      const [state] = createAgentResumeStates(agent, agent, 1);
      expect(state?.sessionId).toBeUndefined();
      expect(state?.armed).toBe(false);
      expect(buildAgentLaunchCommand(state, agent)).toBe(agent);
      if (!state) throw new Error("missing resume descriptor");
      expect(
        buildAgentResumeCommand({
          ...state,
          sessionId: "00000000-0000-4000-8000-000000000001",
        }),
      ).toBe(
        `${resume} 00000000-0000-4000-8000-000000000001`,
      );
    },
  );

  it("does not invent session ids for parallel panes", () => {
    const states = createAgentResumeStates(
      "claude",
      "claude --model opus",
      2,
    );
    expect(states.map((state) => state?.sessionId)).toEqual([
      undefined,
      undefined,
    ]);
  });

  it("does not claim unsupported or custom agents are resumable", () => {
    expect(createAgentResumeStates("codex", "codex", 1)).toEqual([undefined]);
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
    expect(pending).toEqual({
      agent: "opencode",
      armed: false,
      command: "opencode --model x/y",
    });
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

  it("does not rewrite commands that already select a session or chain a shell command", () => {
    expect(createAgentResumeStates("claude", "claude --continue", 1)).toEqual([
      undefined,
    ]);
    expect(createAgentResumeStates("gemini", "prepare && gemini", 1)).toEqual([
      undefined,
    ]);
    expect(createAgentResumeStates("pi", "pi | tee log.txt", 1)).toEqual([
      undefined,
    ]);
    expect(createAgentResumeStates("pi", "prepare & pi", 1)).toEqual([
      undefined,
    ]);
    expect(
      createAgentResumeStates("gemini", "gemini --session-file old.json", 1),
    ).toEqual([undefined]);
    expect(
      createAgentResumeStates("opencode", "opencode --continue", 1),
    ).toEqual([undefined]);
  });

  it("keeps Gemini's sandbox short flag resumable", () => {
    const [state] = createAgentResumeStates("gemini", "gemini -s", 1);
    expect(buildAgentLaunchCommand(state, "gemini -s")).toBe(
      "gemini -s",
    );
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
