import { describe, expect, it } from "vitest";
import {
  buildAgentLaunchCommand,
  buildAgentResumeCommand,
  createAgentResumeStates,
  normalizePersistedAgentResume,
} from "./resume";

describe("agent resume commands", () => {
  it.each([
    ["claude", "claude", "claude --resume"],
    ["antigravity", "agy", "agy --conversation"],
    ["pi", "pi", "pi --session"],
  ] as const)(
    "launches %s unchanged and resumes only after its real session id is known",
    (agent, command, resume) => {
      const [state] = createAgentResumeStates(agent, command, 1);
      expect(state?.sessionId).toBeUndefined();
      expect(state?.armed).toBe(false);
      expect(buildAgentLaunchCommand(state, command)).toBe(command);
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
    expect(
      createAgentResumeStates("antigravity", "prepare && agy", 1),
    ).toEqual([undefined]);
    expect(createAgentResumeStates("pi", "pi | tee log.txt", 1)).toEqual([
      undefined,
    ]);
    expect(createAgentResumeStates("pi", "prepare & pi", 1)).toEqual([
      undefined,
    ]);
    expect(
      createAgentResumeStates(
        "antigravity",
        "agy --conversation old-id",
        1,
      ),
    ).toEqual([undefined]);
    expect(
      createAgentResumeStates("opencode", "opencode --continue", 1),
    ).toEqual([undefined]);
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
