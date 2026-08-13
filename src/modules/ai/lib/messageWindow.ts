import type { UIMessage } from "ai";

export const DEFAULT_VISIBLE_MESSAGE_COUNT = 40;

export function visibleMessageWindow<T>(
  messages: readonly T[],
  visibleCount: number,
): { hiddenCount: number; visible: readonly T[] } {
  const count = Math.max(1, Math.floor(visibleCount));
  const hiddenCount = Math.max(0, messages.length - count);
  return { hiddenCount, visible: messages.slice(hiddenCount) };
}

export function activeRunMessages(
  messages: readonly UIMessage[],
): readonly UIMessage[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") return messages.slice(index);
  }
  return messages.slice(-2);
}
