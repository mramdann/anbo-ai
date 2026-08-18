import { describe, expect, it } from "vitest";
import {
  AGENT_LAUNCHERS,
  canLaunchAgentRequest,
  configuredAgentLaunchRequest,
  DEFAULT_AGENT_LAUNCH_COMMANDS,
  findAgentLauncher,
  getAgentLaunchers,
  normalizeAgentLaunchCommands,
  normalizeCustomCliAgents,
  validateAgentLaunchCommand,
  validateCustomCliAgentName,
} from "./launcher";

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
        antigravity: 42,
        pi: "pi --provider local",
        unknown: "ignored",
      }),
    ).toEqual({
      claude: "cc",
      codex: "codex",
      antigravity: "agy",
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
        icon: "antigravity" as const,
        name: "Aider",
        command: "aider",
      },
    ];
    const launchers = getAgentLaunchers(custom);

    expect(launchers[launchers.length - 1]).toEqual({
      id: "custom:aider",
      icon: "antigravity",
      label: "Aider",
      defaultCommand: "aider",
      supportsHooks: false,
      custom: true,
    });
    expect(findAgentLauncher("custom:aider", custom)?.label).toBe("Aider");
    expect(findAgentLauncher("custom:missing", custom)).toBeUndefined();
  });

  it("resolves spawn commands only from stored built-in and custom settings", () => {
    const commands = { ...DEFAULT_AGENT_LAUNCH_COMMANDS, claude: "cc-safe" };
    const custom = [
      {
        id: "custom:sample" as const,
        icon: "robot" as const,
        name: "Sample",
        command: "sample --resume",
      },
    ];

    expect(configuredAgentLaunchRequest("claude", commands, custom)).toEqual({
      agent: "claude",
      command: "cc-safe",
      instances: 1,
    });
    expect(
      configuredAgentLaunchRequest("custom:sample", commands, custom),
    ).toEqual({
      agent: "custom:sample",
      command: "sample --resume",
      instances: 1,
    });
    expect(configuredAgentLaunchRequest("SAMPLE", commands, custom)).toEqual({
      agent: "custom:sample",
      command: "sample --resume",
      instances: 1,
    });
    expect(
      configuredAgentLaunchRequest("custom:missing", commands, custom),
    ).toBeNull();
  });

  it("resolves every built-in launcher from its stored command", () => {
    const commands = Object.fromEntries(
      AGENT_LAUNCHERS.map((launcher) => [
        launcher.id,
        `${launcher.id} --anbo-test`,
      ]),
    ) as typeof DEFAULT_AGENT_LAUNCH_COMMANDS;

    for (const launcher of AGENT_LAUNCHERS) {
      expect(
        configuredAgentLaunchRequest(launcher.label, commands, []),
      ).toEqual({
        agent: launcher.id,
        command: `${launcher.id} --anbo-test`,
        instances: 1,
      });
    }
  });

  it("migrates the retired Gemini icon on persisted custom agents", () => {
    expect(
      normalizeCustomCliAgents([
        {
          id: "custom:aider",
          icon: "gemini",
          name: "Aider",
          command: "aider",
        },
      ])[0]?.icon,
    ).toBe("antigravity");
  });
});
