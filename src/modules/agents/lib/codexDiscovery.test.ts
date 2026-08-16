import { describe, expect, it, vi } from "vitest";
import { pollCodexSession } from "./codexDiscovery";

describe("pollCodexSession", () => {
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
