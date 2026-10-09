import { invoke } from "@tauri-apps/api/core";
import { describe, expect, it, vi } from "vitest";
import {
  applyGlobalVoiceCaption,
  isPushToTalkKey,
  PUSH_TO_TALK_KEYS,
} from "./globalVoice";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

describe("isPushToTalkKey", () => {
  it("accepts the chords the shell knows and nothing else", () => {
    // The names are the Rust `PttKey` serde names; a stored value the shell
    // cannot read would turn hold to talk off without saying so.
    expect([...PUSH_TO_TALK_KEYS]).toEqual([
      "win",
      "ctrl_win",
      "right_alt",
      "off",
    ]);
    for (const key of PUSH_TO_TALK_KEYS)
      expect(isPushToTalkKey(key)).toBe(true);
    for (const value of ["Win", "ctrl+win", "", null, 3, undefined]) {
      expect(isPushToTalkKey(value)).toBe(false);
    }
  });
});

describe("applyGlobalVoiceCaption", () => {
  it("never lets the last words land after the hide that followed them", async () => {
    const sent: (string | null)[] = [];
    const answers: (() => void)[] = [];
    vi.mocked(invoke).mockImplementation(async (_command, args) => {
      sent.push((args as { text: string | null }).text);
      await new Promise<void>((resolve) => answers.push(resolve));
    });
    const onError = vi.fn();

    const first = applyGlobalVoiceCaption("halo", onError);
    void applyGlobalVoiceCaption("halo semua", onError);
    void applyGlobalVoiceCaption(null, onError);
    // One call at a time: the rest wait for the first answer.
    expect(sent).toEqual(["halo"]);
    answers.shift()?.();
    await vi.waitFor(() => expect(sent).toEqual(["halo", null]));
    answers.shift()?.();
    await first;
    expect(sent).toEqual(["halo", null]);
    expect(onError).not.toHaveBeenCalled();
  });

  it("reports a failed call and keeps going", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error("no window"));
    vi.mocked(invoke).mockResolvedValueOnce(undefined);
    const onError = vi.fn();

    await applyGlobalVoiceCaption("halo", onError);
    expect(onError).toHaveBeenCalledWith(new Error("no window"), "halo");
    await applyGlobalVoiceCaption(null, onError);
    expect(vi.mocked(invoke)).toHaveBeenLastCalledWith("global_voice_caption", {
      text: null,
    });
  });
});
