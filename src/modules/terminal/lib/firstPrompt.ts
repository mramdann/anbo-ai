/**
 * Whether a new shell has ended its first prompt.
 *
 * Terminal automation calls a shell with Anbo's integration started only once
 * it has written OSC 133 B, the end of its first prompt. A Ctrl+C before that
 * can end it: Windows PowerShell has no Ctrl+C handler in its first half
 * second, so Windows closes it with 0xC000013A, and one while its profile runs
 * stops the integration script, leaving every later prompt unmarked. The mark
 * is read from the shell's raw output, so a terminal without a live buffer,
 * whose output nothing parses yet, counts too.
 */

/** OSC 133 B (ESC ] 1 3 3 ; B), which every Anbo shell integration writes
 *  with each prompt. */
const PROMPT_END = [0x1b, 0x5d, 0x31, 0x33, 0x33, 0x3b, 0x42];
const ESC = 0x1b;

/** matchPromptEnd's answer once the whole mark has been seen. */
export const PROMPT_END_LENGTH = PROMPT_END.length;

/**
 * How long after its start a shell may still end its first prompt. A shell
 * without the integration, or whose profile broke it, never writes the mark
 * and must not read as starting for good. Terminal automation waits as long
 * for a first prompt before it gives up on a command. Twenty Windows
 * PowerShells started together on a busy machine took up to 33 s to their
 * first prompt, outside Anbo too, so 30 s refused some of their commands.
 */
export const FIRST_PROMPT_WAIT_MS = 60_000;

/**
 * How many bytes of OSC 133 B the output ends with once `bytes` follows output
 * that ended with `matched` of them, or PROMPT_END_LENGTH as soon as the mark
 * is complete. ESC opens the mark and appears nowhere else in it, so a byte
 * that breaks a match can start a new one only by being ESC.
 */
export function matchPromptEnd(matched: number, bytes: Uint8Array): number {
  let progress = matched;
  let index = 0;
  while (index < bytes.length && progress < PROMPT_END_LENGTH) {
    if (progress === 0) {
      const next = bytes.indexOf(ESC, index);
      if (next < 0) return 0;
      progress = 1;
      index = next + 1;
      continue;
    }
    const byte = bytes[index];
    if (byte === PROMPT_END[progress]) progress += 1;
    else progress = byte === ESC ? 1 : 0;
    index += 1;
  }
  return progress;
}

/** True while a shell that started at `startedAt` has not ended its first
 *  prompt and still may. */
export function awaitingFirstPrompt(
  promptEnded: boolean,
  startedAt: number | null,
  now: number,
): boolean {
  return (
    !promptEnded && startedAt !== null && now - startedAt < FIRST_PROMPT_WAIT_MS
  );
}
