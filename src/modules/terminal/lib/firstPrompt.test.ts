import { describe, expect, it } from "vitest";
import {
  awaitingFirstPrompt,
  FIRST_PROMPT_WAIT_MS,
  matchPromptEnd,
  PROMPT_END_LENGTH,
} from "./firstPrompt";

const enc = new TextEncoder();

function feed(...chunks: string[]): number {
  return chunks.reduce(
    (matched, chunk) => matchPromptEnd(matched, enc.encode(chunk)),
    0,
  );
}

// What Anbo's profile.ps1 writes for a first prompt.
const FIRST_PROMPT =
  "\x1b]133;D;0\x1b\\\x1b]133;A\x1b\\\x1b]7;file://HOST/D:/work\x1b\\PS D:\\work> \x1b]133;B\x1b\\";

describe("matchPromptEnd", () => {
  it("finds the end of the first prompt among the other marks", () => {
    expect(feed("Windows PowerShell\r\n", FIRST_PROMPT)).toBe(
      PROMPT_END_LENGTH,
    );
  });

  it("finds a mark split between chunks at any byte", () => {
    for (let cut = 1; cut < FIRST_PROMPT.length; cut++) {
      expect(
        feed(FIRST_PROMPT.slice(0, cut), FIRST_PROMPT.slice(cut)),
        `cut at ${cut}`,
      ).toBe(PROMPT_END_LENGTH);
    }
    expect(feed("\x1b", "]", "1", "3", "3", ";", "B")).toBe(PROMPT_END_LENGTH);
  });

  it("takes no other mark, and no output, for the end of a prompt", () => {
    expect(feed("\x1b]133;A\x1b\\\x1b]133;C;dir\x1b\\\x1b]133;D;1\x1b\\")).toBe(
      0,
    );
    expect(feed("\x1b[32mLoading personal profiles\x1b[0m\r\n")).toBe(0);
    expect(feed("]133;B")).toBe(0);
    expect(feed("\x1b]1330;B", "\x1b]13;B")).toBe(0);
  });

  it("carries a partial mark into the next chunk", () => {
    expect(feed("profile loaded \x1b]13")).toBe(4);
    expect(feed("\x1b]133;")).toBe(6);
    expect(feed("\x1b]133;", "x")).toBe(0);
  });

  it("starts again at an ESC that breaks a match", () => {
    expect(feed("\x1b]1\x1b]133;B")).toBe(PROMPT_END_LENGTH);
    expect(feed("\x1b]133", "\x1b]133;B")).toBe(PROMPT_END_LENGTH);
  });
});

describe("awaitingFirstPrompt", () => {
  it("waits from the shell's start until its first prompt ends", () => {
    expect(awaitingFirstPrompt(false, 1_000, 1_000)).toBe(true);
    expect(awaitingFirstPrompt(false, 1_000, 3_500)).toBe(true);
    expect(awaitingFirstPrompt(true, 1_000, 3_500)).toBe(false);
  });

  it("still waits for a shell started with many others", () => {
    // Twenty Windows PowerShells started together took up to 33 s.
    expect(awaitingFirstPrompt(false, 1_000, 1_000 + 45_000)).toBe(true);
  });

  it("stops waiting for a shell that never marks a prompt", () => {
    expect(
      awaitingFirstPrompt(false, 1_000, 1_000 + FIRST_PROMPT_WAIT_MS - 1),
    ).toBe(true);
    expect(
      awaitingFirstPrompt(false, 1_000, 1_000 + FIRST_PROMPT_WAIT_MS),
    ).toBe(false);
  });

  it("is not waiting before the shell has started", () => {
    expect(awaitingFirstPrompt(false, null, 1_000)).toBe(false);
  });
});
