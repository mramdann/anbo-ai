export type TerminalBufferState = {
  type: "normal" | "alternate";
  baseY: number;
};

export function shouldShowTerminalScrollbar(
  buffer: TerminalBufferState,
): boolean {
  return buffer.type === "normal" && buffer.baseY > 0;
}
