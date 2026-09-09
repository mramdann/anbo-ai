import { describe, expect, it, vi } from "vitest";
import { pollCodexSession } from "./codexDiscovery";

describe("pollCodexSession", () => {
  it("discards an in-flight result after the terminal generation changes", async () => {
    let current = true;
    const lookup = vi.fn(async () => {
      current = false;
      return "old-session";
    });
    await expect(
      pollCodexSession(lookup, { isCurrent: () => current }),
    ).resolves.toBeNull();
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("stops polling when its PTY closes during a wait", async () => {
    let current = true;
    const lookup = vi.fn(async () => null);
    await expect(
      pollCodexSession(lookup, {
        isCurrent: () => current,
        sleep: async () => {
          current = false;
        },
      }),
    ).resolves.toBeNull();
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("rejects stale evidence from the final deadline lookup", async () => {
    let current = true;
    const lookup = vi
      .fn<() => Promise<string | null>>()
      .mockResolvedValueOnce(null)
      .mockImplementationOnce(async () => {
        current = false;
        return "old-session";
      });
    await expect(
      pollCodexSession(lookup, { timeoutMs: 0, isCurrent: () => current }),
    ).resolves.toBeNull();
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it("returns a session discovered before the deadline", async () => {
    let clock = 0;
    const lookup = vi
      .fn<() => Promise<string | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("session-id");

    await expect(
      pollCodexSession(lookup, {
        timeoutMs: 100,
        intervalMs: 50,
        now: () => clock,
        sleep: async (delayMs) => {
          clock += delayMs;
        },
      }),
    ).resolves.toBe("session-id");
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it("performs a final lookup after the deadline", async () => {
    let clock = 0;
    const lookup = vi
      .fn<() => Promise<string | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("boundary-session");

    await expect(
      pollCodexSession(lookup, {
        timeoutMs: 100,
        intervalMs: 50,
        now: () => clock,
        sleep: async (delayMs) => {
          clock += delayMs;
        },
      }),
    ).resolves.toBe("boundary-session");
    expect(lookup).toHaveBeenCalledTimes(4);
  });

  it("returns null only after the final lookup also misses", async () => {
    let clock = 0;
    const lookup = vi
      .fn<() => Promise<string | null>>()
      .mockResolvedValue(null);

    await expect(
      pollCodexSession(lookup, {
        timeoutMs: 100,
        intervalMs: 50,
        now: () => clock,
        sleep: async (delayMs) => {
          clock += delayMs;
        },
      }),
    ).resolves.toBeNull();
    expect(lookup).toHaveBeenCalledTimes(4);
  });
});
