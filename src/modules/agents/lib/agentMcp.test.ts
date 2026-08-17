import { describe, expect, it } from "vitest";
import { normalizeAgentMcpEnabled, withAgentMcpRuntime } from "./agentMcp";

describe("agent MCP preferences", () => {
  it("defaults the four supported agents on and preserves explicit opt-outs", () => {
    expect(normalizeAgentMcpEnabled({ claude: false })).toEqual({
      claude: false,
      codex: true,
      antigravity: true,
      opencode: true,
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
    ).toBe(
      "claude --model sonnet --mcp-config 'C:\\work\\demo\\.claude\\anbo-mcp.json'",
    );
  });

  it("does not override a custom Claude MCP config", () => {
    const command = "claude --mcp-config custom.json";
    expect(withAgentMcpRuntime("claude", command, "C:\\work\\demo", true)).toBe(
      command,
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
  });
});
