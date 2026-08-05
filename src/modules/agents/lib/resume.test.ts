import { describe, expect, it } from "vitest";
import {
  buildAgentLaunchCommand,
  buildAgentResumeCommand,
  createAgentResumeStates,
  normalizePersistedAgentResume,
} from "./resume";

const IDS = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
];

function idAllocator(): () => string {
  let index = 0;
  return () => IDS[index++];
}

describe("agent resume commands", () => {
  it.each([
    ["claude", "claude --session-id", "claude --resume"],
    ["gemini", "gemini --session-id", "gemini --resume"],
    ["pi", "pi --session-id", "pi --session"],
  ] as const)(
    "pins and resumes %s by exact session id",
    (agent, start, resume) => {
      const [state] = createAgentResumeStates(agent, agent, 1, idAllocator());
      expect(state?.sessionId).toBe(IDS[0]);
      expect(state?.armed).toBe(false);
      expect(buildAgentLaunchCommand(state, agent)).toBe(`${start} ${IDS[0]}`);
      expect(state && buildAgentResumeCommand(state)).toBe(
        `${resume} ${IDS[0]}`,
      );
    },
  );

  it("allocates a distinct session id for every exact-resume pane", () => {
    const states = createAgentResumeStates(
      "claude",
      "claude --model opus",
      2,
      idAllocator(),
    );
    expect(states.map((state) => state?.sessionId)).toEqual(IDS);
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
      idAllocator(),
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
    const [state] = createAgentResumeStates(
      "gemini",
      "gemini -s",
      1,
      idAllocator(),
    );
    expect(buildAgentLaunchCommand(state, "gemini -s")).toBe(
      `gemini -s --session-id ${IDS[0]}`,
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
