import { leafIds } from "@/modules/terminal";
import { describe, expect, it } from "vitest";
import {
  AGENT_LAUNCHERS,
  type AgentInstanceCount,
  canLaunchAgentRequest,
  createAgentPanePlan,
  DEFAULT_AGENT_LAUNCH_COMMANDS,
  findAgentLauncher,
  getAgentLaunchers,
  normalizeAgentLaunchCommands,
  normalizeCustomCliAgents,
  validateAgentLaunchCommand,
  validateCustomCliAgentName,
} from "./launcher";

function allocator(start = 1) {
  let id = start;
  return () => id++;
}

describe("agent launch commands", () => {
  it("defines a non-empty default for every launcher", () => {
    for (const launcher of AGENT_LAUNCHERS) {
      expect(DEFAULT_AGENT_LAUNCH_COMMANDS[launcher.id]).toBe(
        launcher.defaultCommand,
      );
    }
  });

  it("accepts aliases and arguments while trimming whitespace", () => {
    expect(validateAgentLaunchCommand("  cc --model opus  ")).toEqual({
      ok: true,
      command: "cc --model opus",
    });
  });

  it("rejects blank, multiline, and oversized commands", () => {
    expect(validateAgentLaunchCommand(" ")).toMatchObject({ ok: false });
    expect(validateAgentLaunchCommand("codex\nwhoami")).toMatchObject({
      ok: false,
    });
    expect(validateAgentLaunchCommand("x".repeat(257))).toMatchObject({
      ok: false,
    });
  });

  it("falls back per agent when persisted preferences are malformed", () => {
    expect(
      normalizeAgentLaunchCommands({
        claude: "cc",
        codex: "",
        gemini: 42,
        pi: "pi --provider local",
        unknown: "ignored",
      }),
    ).toEqual({
      claude: "cc",
      codex: "codex",
      gemini: "gemini",
      pi: "pi --provider local",
      opencode: "opencode",
      grok: "grok",
    });
  });
});

describe("parallel agent limits", () => {
  it("allows two OpenCode instances but blocks a third", () => {
    const request = {
      agent: "opencode" as const,
      command: "opencode",
      instances: 1 as const,
    };

    expect(canLaunchAgentRequest(request, ["opencode"])).toBe(true);
    expect(canLaunchAgentRequest(request, ["opencode", "opencode"])).toBe(
      false,
    );
  });

  it("does not limit other agent launchers", () => {
    expect(
      canLaunchAgentRequest(
        { agent: "claude", command: "claude", instances: 4 },
        ["opencode", "opencode"],
      ),
    ).toBe(true);
  });
});

describe("custom CLI agents", () => {
  it("normalizes valid agents and removes malformed or duplicate entries", () => {
    expect(
      normalizeCustomCliAgents([
        { id: "custom:aider", name: "  Aider  ", command: "  aider --fast  " },
        { id: "custom:duplicate-name", name: "aider", command: "other" },
        { id: "custom:bad-command", name: "Bad", command: "bad\ncommand" },
        { id: "invalid", name: "Invalid", command: "invalid" },
        null,
      ]),
    ).toEqual([
      {
        id: "custom:aider",
        icon: "robot",
        name: "Aider",
        command: "aider --fast",
      },
    ]);
  });

  it("rejects duplicate and built-in names", () => {
    const existing = [
      {
        id: "custom:aider" as const,
        icon: "robot" as const,
        name: "Aider",
        command: "aider",
      },
    ];

    expect(validateCustomCliAgentName("Claude", existing)).toMatchObject({
      ok: false,
    });
    expect(validateCustomCliAgentName("aider", existing)).toMatchObject({
      ok: false,
    });
    expect(
      validateCustomCliAgentName("Aider", existing, "custom:aider"),
    ).toEqual({ ok: true, name: "Aider" });
  });

  it("merges custom launchers without granting hooks", () => {
    const custom = [
      {
        id: "custom:aider" as const,
        icon: "gemini" as const,
        name: "Aider",
        command: "aider",
      },
    ];
    const launchers = getAgentLaunchers(custom);

    expect(launchers[launchers.length - 1]).toEqual({
      id: "custom:aider",
      icon: "gemini",
      label: "Aider",
      defaultCommand: "aider",
      supportsHooks: false,
      custom: true,
    });
    expect(findAgentLauncher("custom:aider", custom)?.label).toBe("Aider");
    expect(findAgentLauncher("custom:missing", custom)).toBeUndefined();
  });
});

describe("createAgentPanePlan", () => {
  it.each([1, 2, 3, 4] as AgentInstanceCount[])(
    "creates %i unique leaves with the requested cwd",
    (instances) => {
      const plan = createAgentPanePlan(instances, allocator(), "/workspace");
      const ids = leafIds(plan.paneTree);
      expect(ids).toEqual(plan.leafIds);
      expect(new Set(ids).size).toBe(instances);

      const visit = (node: typeof plan.paneTree) => {
        if (node.kind === "leaf") {
          expect(node.cwd).toBe("/workspace");
          return;
        }
        node.children.forEach(visit);
      };
      visit(plan.paneTree);
    },
  );

  it("balances four agents into a two by two grid", () => {
    const { paneTree } = createAgentPanePlan(4, allocator());
    expect(paneTree.kind).toBe("split");
    if (paneTree.kind !== "split") return;
    expect(paneTree.dir).toBe("row");
    expect(paneTree.children).toHaveLength(2);
    expect(
      paneTree.children.every(
        (child) =>
          child.kind === "split" &&
          child.dir === "col" &&
          child.children.length === 2,
      ),
    ).toBe(true);
  });

  it("attaches distinct resume metadata to each agent leaf", () => {
    const resumes = [
      {
        agent: "claude" as const,
        command: "claude",
        sessionId: "00000000-0000-4000-8000-000000000001",
      },
      {
        agent: "claude" as const,
        command: "claude",
        sessionId: "00000000-0000-4000-8000-000000000002",
      },
    ];
    const { paneTree } = createAgentPanePlan(
      2,
      allocator(),
      "/workspace",
      resumes,
    );
    expect(paneTree.kind).toBe("split");
    if (paneTree.kind !== "split") return;
    expect(
      paneTree.children.map((node) =>
        node.kind === "leaf" ? node.agentResume : undefined,
      ),
    ).toEqual(resumes);
  });

  it("rejects counts outside the renderer pool limit", () => {
    expect(() =>
      createAgentPanePlan(0 as AgentInstanceCount, allocator()),
    ).toThrow(RangeError);
    expect(() =>
      createAgentPanePlan(5 as AgentInstanceCount, allocator()),
    ).toThrow(RangeError);
  });
});
