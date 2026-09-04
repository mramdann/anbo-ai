import { afterEach, describe, expect, it, vi } from "vitest";
import { whisperCppReachable } from "./stt";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("local Whisper reachability", () => {
  it("accepts any answer from a loopback server", async () => {
    // whisper.cpp has no health route, so a 404 still proves it is listening.
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(whisperCppReachable("http://127.0.0.1:8080")).resolves.toBe(
      true,
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("reports a refused connection instead of letting a take be recorded", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
    );

    await expect(whisperCppReachable("http://127.0.0.1:8080")).resolves.toBe(
      false,
    );
  });

  it("refuses a non-loopback endpoint without reaching for the network", async () => {
    // The offline provider must never post recorded audio off the machine, so
    // an endpoint like this is unreachable by definition, not by probe.
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(whisperCppReachable("https://api.example.com")).resolves.toBe(
      false,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
