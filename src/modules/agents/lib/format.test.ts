import { describe, expect, it } from "vitest";
import {
  displayAgent,
  displayAgentInstance,
  formatAgentDuration,
} from "./format";

describe("displayAgent", () => {
  it("maps known agent ids to their display labels", () => {
    expect(displayAgent("claude")).toBe("Claude Code");
    expect(displayAgent("codex")).toBe("Codex");
    expect(displayAgent("pi")).toBe("Pi");
  });

  it("looks the label up case-insensitively", () => {
    expect(displayAgent("CLAUDE")).toBe("Claude Code");
    expect(displayAgent("AnTiGrAvItY")).toBe("Antigravity");
  });

  it("capitalizes an unknown agent id", () => {
    expect(displayAgent("foobar")).toBe("Foobar");
  });

  it("falls back to 'Agent' for an empty id", () => {
    expect(displayAgent("")).toBe("Agent");
  });
});

describe("displayAgentInstance", () => {
  it("prefers the workspace callsign over the CLI label", () => {
    expect(displayAgentInstance("claude", "Leander")).toBe("Leander");
    expect(displayAgentInstance("codex", "Mizar")).toBe("Mizar");
  });

  it("falls back to the CLI label when no callsign is available", () => {
    expect(displayAgentInstance("claude", " ")).toBe("Claude Code");
    expect(displayAgentInstance("codex")).toBe("Codex");
  });
});

describe("formatAgentDuration", () => {
  it.each([
    [0, "0s"],
    [999, "0s"],
    [42_000, "42s"],
    [59_999, "59s"],
    [60_000, "1m"],
    [252_400, "4m"],
    [3_599_999, "59m"],
    [3_600_000, "60m"],
    [5_000_000, "83m"],
    [-5, "0s"],
  ])("formats %d ms as %s", (ms, text) => {
    expect(formatAgentDuration(ms)).toBe(text);
  });
});
