import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderKeys } from "./keyring";
import { transcribeAudio, whisperCppReachable } from "./stt";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("local Whisper reachability", () => {
  it("accepts any answer from a loopback server", async () => {
    // whisper.cpp has no health route, so a 404 still proves it is listening.
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("", { status: 404 }));
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

describe("Groq transcription upload", () => {
  const audio = () => new Blob([new Uint8Array(16)], { type: "audio/webm" });
  const keys = { groq: "test-key" } as unknown as ProviderKeys;

  it("sends the same recording once more after a network failure", async () => {
    // A pooled connection that died while idle rejects the upload before Groq
    // sees it; the take must not be lost to that.
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(new Response("halo dunia", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(transcribeAudio(audio(), "groq", keys)).resolves.toBe(
      "halo dunia",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1].body).toBe(
      fetchMock.mock.calls[0][1].body,
    );
  });

  it("does not repeat a request the service answered", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("invalid key", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(transcribeAudio(audio(), "groq", keys)).rejects.toThrow(
      "STT request failed (401): invalid key",
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("names the service when the network fails twice", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValue(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(transcribeAudio(audio(), "groq", keys)).rejects.toThrow(
      "Could not reach Groq after two attempts (Failed to fetch)",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("transcription language", () => {
  const keys = { groq: "test-key" } as unknown as ProviderKeys;
  const local = { whispercppBaseURL: "http://127.0.0.1:8080" };
  const sentForm = (fetchMock: ReturnType<typeof vi.fn>) =>
    fetchMock.mock.calls[0][1].body as FormData;
  const wav = () => new Blob([new Uint8Array(44)], { type: "audio/wav" });

  it("names the chosen language to Groq and leaves it out on auto", async () => {
    const fetchMock = vi.fn(async () => new Response("halo", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const audio = new Blob([new Uint8Array(16)], { type: "audio/webm" });

    await transcribeAudio(audio, "groq", keys, { language: "id" });
    expect(sentForm(fetchMock).get("language")).toBe("id");
    expect((sentForm(fetchMock).get("file") as File).name).toBe("audio.webm");

    fetchMock.mockClear();
    await transcribeAudio(audio, "groq", keys, { language: "auto" });
    expect(sentForm(fetchMock).has("language")).toBe(false);
  });

  it("sends a sentence's WAV to the local server as it is, with the language", async () => {
    const fetchMock = vi.fn(async () => new Response("hello", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const audio = wav();

    await transcribeAudio(audio, "whispercpp", {} as ProviderKeys, {
      ...local,
      language: "en",
    });
    const form = sentForm(fetchMock);
    expect(form.get("language")).toBe("en");
    expect(await (form.get("file") as File).arrayBuffer()).toEqual(
      await audio.arrayBuffer(),
    );
  });
});
