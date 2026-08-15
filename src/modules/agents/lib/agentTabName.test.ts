import { describe, expect, it } from "vitest";
import {
  allocateAgentTabNames,
  BUILT_IN_AGENT_ALIASES,
  canonicalAgentTabIdentity,
  normalizeAgentTabIdentity,
} from "./agentTabName";

describe("agent tab names", () => {
  it("uses the original name first and preferred aliases after it", () => {
    expect(
      allocateAgentTabNames(
        canonicalAgentTabIdentity("claude"),
        4,
        [],
        () => 0,
      ),
    ).toEqual(["Claude", "Atlas", "Aurelia", "Caspian"]);
  });

  it("randomizes aliases after keeping the canonical name first", () => {
    expect(
      allocateAgentTabNames(
        canonicalAgentTabIdentity("claude"),
        4,
        [],
        (upperBound) => upperBound - 1,
      ),
    ).toEqual(["Claude", "Soren", "Marlowe", "Leander"]);
  });

  it("skips names already occupied by any tab in the workspace", () => {
    expect(
      allocateAgentTabNames(
        canonicalAgentTabIdentity("opencode"),
        3,
        ["OpenCode", "Aspen", "Cedar"],
        () => 0,
      ),
    ).toEqual(["Rowan", "Willow", "Maple"]);
  });

  it("treats collisions as case insensitive", () => {
    expect(
      allocateAgentTabNames(
        canonicalAgentTabIdentity("codex"),
        2,
        ["CODEX", "orion"],
        () => 0,
      ),
    ).toEqual(["Sirius", "Altair"]);
  });

  it("keeps canonical CLI names exclusive to their owner", () => {
    expect(
      allocateAgentTabNames(
        { launcherId: "custom:claude-copy", icon: "robot", label: "Claude" },
        1,
        [],
        () => 0,
      ),
    ).toEqual(["Atlas"]);
  });

  it("keeps every curated alias unique and no longer than seven characters", () => {
    const aliases = Object.values(BUILT_IN_AGENT_ALIASES).flat();
    expect(new Set(aliases.map((name) => name.toLocaleLowerCase())).size).toBe(
      aliases.length,
    );
    expect(aliases.every((name) => name.length <= 7)).toBe(true);
    expect(aliases).toHaveLength(120);
  });

  it("generates readable bounded fallbacks after the curated pool is full", () => {
    const names = allocateAgentTabNames(
      canonicalAgentTabIdentity("claude"),
      4,
      ["Claude", ...Object.values(BUILT_IN_AGENT_ALIASES).flat()],
      () => 0,
    );
    expect(names).toHaveLength(4);
    expect(names.every((name) => /^[A-Za-z][A-Za-z0-9]{0,6}$/.test(name))).toBe(
      true,
    );
    expect(new Set(names).size).toBe(names.length);
  });

  it("normalizes safe persisted identity metadata", () => {
    expect(
      normalizeAgentTabIdentity({
        launcherId: "claude",
        icon: "claude",
        label: "Claude",
        name: "Atlas",
      }),
    ).toEqual({
      launcherId: "claude",
      icon: "claude",
      label: "Claude",
      name: "Atlas",
    });
    expect(
      normalizeAgentTabIdentity({
        launcherId: "claude",
        icon: "claude",
        label: "Claude",
        name: "Too Long",
      }),
    ).toBeUndefined();
    expect(
      normalizeAgentTabIdentity({
        launcherId: "custom:copy",
        icon: "robot",
        label: "Claude",
        name: "Claude",
      }),
    ).toBeUndefined();
  });

  it("migrates persisted Gemini launcher identity to Antigravity", () => {
    expect(
      normalizeAgentTabIdentity({
        launcherId: "gemini",
        icon: "gemini",
        label: "Gemini",
        name: "Gemini",
      }),
    ).toEqual({
      launcherId: "antigravity",
      icon: "antigravity",
      label: "Antigravity",
      name: "Antigravity",
    });
  });
});
