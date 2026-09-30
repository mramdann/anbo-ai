import { describe, expect, it } from "vitest";
import {
  agentStatusLabel,
  bellBadgeCount,
  nextDurationTickMs,
  notificationLabel,
} from "./bell";
import type { AgentNotification, AgentSession } from "./types";

function session(overrides: Partial<AgentSession>): AgentSession {
  return {
    leafId: 1,
    tabId: 1,
    agent: "claude",
    name: "Leander",
    status: "waiting",
    phase: "finished",
    startedAt: 0,
    lastActivityAt: 0,
    attentionSince: null,
    ...overrides,
  };
}

function alert(overrides: Partial<AgentNotification>): AgentNotification {
  return {
    id: "n1",
    source: "terminal",
    leafId: 1,
    tabId: 1,
    agent: "claude",
    name: "Leander",
    kind: "finished",
    at: 0,
    read: false,
    ...overrides,
  };
}

describe("bellBadgeCount", () => {
  it("does not count agents idling at their prompt", () => {
    const idle = [session({}), session({ leafId: 2 }), session({ leafId: 3 })];
    expect(bellBadgeCount(idle, null, [])).toBe(0);
  });

  it("counts a finished turn once, not also as a waiting agent", () => {
    expect(bellBadgeCount([session({})], null, [alert({})])).toBe(1);
    expect(bellBadgeCount([session({})], null, [alert({ read: true })])).toBe(
      0,
    );
  });

  it("counts every agent blocked at a prompt and the in-app agent awaiting approval", () => {
    const sessions = [
      session({ phase: "attention" }),
      session({ leafId: 2, status: "working", phase: "working" }),
    ];
    expect(
      bellBadgeCount(sessions, { agent: "Anbo", status: "waiting" }, []),
    ).toBe(2);
    expect(
      bellBadgeCount(sessions, { agent: "Anbo", status: "working" }, []),
    ).toBe(1);
  });
});

describe("agentStatusLabel", () => {
  it("says how long a turn has been running", () => {
    const working = { status: "working", phase: "working" } as const;
    expect(agentStatusLabel(working, 192_000)).toBe("working · 3m");
    expect(agentStatusLabel(working, 12_000)).toBe("working · 12s");
    expect(agentStatusLabel(working, null)).toBe("working");
  });

  it("keeps blocked and waiting apart, and names background work", () => {
    expect(
      agentStatusLabel({ status: "waiting", phase: "attention" }, null),
    ).toBe("needs you");
    expect(
      agentStatusLabel({ status: "waiting", phase: "finished" }, null),
    ).toBe("waiting");
    expect(
      agentStatusLabel(
        { status: "waiting", phase: "finished", background: "1 task" },
        null,
      ),
    ).toBe("waiting · 1 task");
  });
});

describe("notificationLabel", () => {
  it("adds how long a finished turn took", () => {
    expect(notificationLabel({ kind: "finished", durationMs: 252_000 })).toBe(
      "finished · 4m",
    );
    expect(notificationLabel({ kind: "finished", durationMs: 400 })).toBe(
      "finished",
    );
    expect(notificationLabel({ kind: "finished" })).toBe("finished");
    expect(notificationLabel({ kind: "error", durationMs: 9_000 })).toBe(
      "failed",
    );
  });
});

describe("nextDurationTickMs", () => {
  it("wakes each second under a minute, then on the next whole minute", () => {
    expect(nextDurationTickMs([], 10_000)).toBeNull();
    expect(nextDurationTickMs([0], 12_300)).toBe(700);
    expect(nextDurationTickMs([0], 59_500)).toBe(500);
    expect(nextDurationTickMs([0], 60_000)).toBe(60_000);
    expect(nextDurationTickMs([0], 185_000)).toBe(55_000);
  });

  it("follows whichever working row changes first", () => {
    expect(nextDurationTickMs([0, 190_000], 200_000)).toBe(1_000);
    expect(nextDurationTickMs([0, 20_000], 200_000)).toBe(40_000);
  });
});
