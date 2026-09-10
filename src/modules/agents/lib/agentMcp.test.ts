import { describe, expect, it } from "vitest";
import {
  agentMcpFlavour,
  DEFAULT_AGENT_MCP_ENABLED,
  normalizeAgentMcpEnabled,
  withAgentMcpRuntime,
} from "./agentMcp";

describe("agent MCP preferences", () => {
  it("defaults every supported agent on and preserves explicit opt-outs", () => {
    expect(normalizeAgentMcpEnabled({ claude: false })).toEqual({
      claude: false,
      codex: true,
      antigravity: true,
      opencode: true,
      kimi: true,
    });
  });
});

describe("agent MCP runtime wiring", () => {
  it("adds Claude's dedicated config without changing the stored command", () => {
    expect(
      withAgentMcpRuntime(
        "claude",
        "claude --model sonnet",
        "C:\\work\\demo",
        true,
      ),
    ).toBe("claude --model sonnet --mcp-config .claude/anbo-mcp.json");
  });

  it("does not override a custom Claude MCP config", () => {
    const command = "claude --mcp-config custom.json";
    expect(withAgentMcpRuntime("claude", command, "C:\\work\\demo", true)).toBe(
      command,
    );
  });

  it("still wires a wrapper that carries its own quoted options", () => {
    // The shape a real custom launcher takes: the same CLI behind a different
    // settings file. Quotes and a $HOME are not the shell operators the guard
    // is looking for, so this one must still be given the browser tools.
    expect(
      withAgentMcpRuntime(
        "claude",
        'claude --dangerously-skip-permissions --settings "$HOME\\.claude\\settings-glm.json"',
        "D:\\work\\demo",
        true,
      ),
    ).toBe(
      'claude --dangerously-skip-permissions --settings "$HOME\\.claude\\settings-glm.json" --mcp-config .claude/anbo-mcp.json',
    );
  });

  it("does not rewrite compound custom commands", () => {
    const command = "prepare-agent; claude";
    expect(withAgentMcpRuntime("claude", command, "C:\\work\\demo", true)).toBe(
      command,
    );
  });

  it("scopes OpenCode's custom config to the launched process command", () => {
    expect(
      withAgentMcpRuntime("opencode", "opencode", "/home/me/project", false),
    ).toBe(
      "OPENCODE_CONFIG='/home/me/project/.opencode/anbo-mcp.json' opencode",
    );
  });

  it("does not alter agents with native project config discovery", () => {
    expect(withAgentMcpRuntime("codex", "codex", "C:\\work\\demo", true)).toBe(
      "codex",
    );
    expect(
      withAgentMcpRuntime("antigravity", "agy", "C:\\work\\demo", true),
    ).toBe("agy");
    // Kimi reads .kimi-code/mcp.json under the directory it was started in, so
    // the launch command is left exactly as the user wrote it.
    expect(
      withAgentMcpRuntime("kimi", "kimi --auto", "D:\\work\\demo", true),
    ).toBe("kimi --auto");
  });
});

describe("which MCP wiring a launch gets", () => {
  const enabled = { ...DEFAULT_AGENT_MCP_ENABLED };

  it("reads a custom launcher's flavour from its icon", () => {
    // A custom launcher is nearly always one of the known CLIs behind a
    // different command, and picking its icon has already said which one.
    // Before this it fell outside isMcpAgentId and launched with no MCP at all,
    // so the browser tools were invisible to it however it was configured.
    const custom = [
      {
        id: "custom:wrap",
        icon: "claude",
        name: "ClaudeZ",
        command: "myclaude",
        mcp: true,
      },
      { id: "custom:off", icon: "claude", name: "Off", command: "myclaude" },
      {
        id: "custom:robot",
        icon: "robot",
        name: "Robot",
        command: "mycli",
        mcp: true,
      },
    ] as const;

    expect(agentMcpFlavour("custom:wrap", enabled, custom)).toBe("claude");
    // Switched off, and an icon Anbo has no wiring for, both mean no MCP --
    // the second so an unrecognised CLI is never handed Claude's flags.
    expect(agentMcpFlavour("custom:off", enabled, custom)).toBeNull();
    expect(agentMcpFlavour("custom:robot", enabled, custom)).toBeNull();
    expect(agentMcpFlavour("custom:missing", enabled, custom)).toBeNull();
  });

  it("still lets a built-in answer for itself, toggle included", () => {
    expect(agentMcpFlavour("codex", enabled, [])).toBe("codex");
    expect(
      agentMcpFlavour("codex", { ...enabled, codex: false }, []),
    ).toBeNull();
    // A CLI Anbo has no wiring for stays off whatever the toggles say.
    expect(agentMcpFlavour("grok", enabled, [])).toBeNull();
  });
});
