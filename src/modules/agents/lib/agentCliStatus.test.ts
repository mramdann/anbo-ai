import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

const {
  AGENT_CLI_PROBE_TTL_MS,
  agentCliAvailability,
  benchOrder,
  agentCliProbes,
  forgetAgentCliStatus,
  probeAgentClis,
  staleAgentCliCommands,
} = await import("./agentCliStatus");

beforeEach(() => {
  invoke.mockReset();
  forgetAgentCliStatus();
});

describe("what Anbo knows about an agent CLI", () => {
  it("keeps an unanswered command apart from one it could not find", () => {
    // The probe lands after the first paint. If those frames read as "missing"
    // the whole bench would grey itself out and light up again on every open.
    expect(agentCliAvailability({}, "claude")).toBe("unknown");
    expect(
      agentCliAvailability({ claude: { installed: false, at: 0 } }, "claude"),
    ).toBe("missing");
    expect(
      agentCliAvailability({ claude: { installed: true, at: 0 } }, "claude"),
    ).toBe("ready");
  });

  it("does not let an answer expire on screen, only in the cache", () => {
    // Age decides when to ask again, never what to show: an answer older than
    // the window still renders as it did, so nothing changes under the user
    // while the next probe is in flight.
    const probes = { claude: { installed: true, at: 0 } };
    const later = AGENT_CLI_PROBE_TTL_MS * 10;
    expect(agentCliAvailability(probes, "claude")).toBe("ready");
    expect(staleAgentCliCommands(["claude"], probes, later)).toEqual([
      "claude",
    ]);
  });

  it("asks only for commands that are runnable, new and not repeated", () => {
    const probes = { claude: { installed: true, at: 1_000 } };
    expect(
      staleAgentCliCommands(
        ["claude", "claude", "codex", "  ", ""],
        probes,
        1_000,
      ),
    ).toEqual(["codex"]);
  });
});

describe("the order agents sit in", () => {
  const bench = ["claude", "pi", "codex", "grok", "opencode"];
  const order = (missing: readonly string[]) =>
    benchOrder(bench, (agent) =>
      missing.includes(agent) ? "missing" : "ready",
    );

  it("moves what cannot run to the end without shuffling the rest", () => {
    // A supported CLI the user has not installed still belongs on the bench,
    // but not between two agents they can actually pick.
    expect(order(["pi", "grok"])).toEqual([
      "claude",
      "codex",
      "opencode",
      "pi",
      "grok",
    ]);
  });

  it("leaves the bench exactly as declared while answers are still coming", () => {
    // Every agent unanswered, then every agent present: neither case is a
    // reason to reorder, so the deck holds still until an answer says missing.
    expect(benchOrder(bench, () => "unknown")).toEqual(bench);
    expect(order([])).toEqual(bench);
  });

  it("keeps a bench nothing can run in its declared order", () => {
    expect(order(bench)).toEqual(bench);
  });
});

describe("probing the machine", () => {
  it("remembers both answers, so a missing CLI is asked about once", async () => {
    invoke.mockResolvedValue({ claude: true, "nope --go": false });
    await probeAgentClis(["claude", "nope --go"]);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("agent_cli_status", {
      commands: ["claude", "nope --go"],
    });

    expect(agentCliAvailability(agentCliProbes(), "claude")).toBe("ready");
    expect(agentCliAvailability(agentCliProbes(), "nope --go")).toBe("missing");

    await probeAgentClis(["claude", "nope --go"]);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("leaves the bench as it was when the probe fails", async () => {
    // Anything else would grey out working agents because one IPC call broke.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    invoke.mockRejectedValue(new Error("no backend"));
    await probeAgentClis(["claude"]);
    expect(agentCliAvailability(agentCliProbes(), "claude")).toBe("unknown");
    // And the next open is free to ask again.
    invoke.mockResolvedValue({ claude: true });
    await probeAgentClis(["claude"]);
    expect(agentCliAvailability(agentCliProbes(), "claude")).toBe("ready");
    warn.mockRestore();
  });

  it("treats a command the backend did not answer for as missing", async () => {
    // The reply is keyed by command; a key that never came back is not a CLI
    // Anbo can vouch for, and vouching wrongly means a tab that dies at once.
    invoke.mockResolvedValue({});
    await probeAgentClis(["ghost"]);
    expect(agentCliAvailability(agentCliProbes(), "ghost")).toBe("missing");
  });
});
