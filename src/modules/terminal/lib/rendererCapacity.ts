// CPU buffers and GPU contexts have different lifetimes. Keep the normal
// cache small, but never recycle a live TUI merely to satisfy the GPU budget.
export const WARM_BUFFER_LIMIT = 5;
export const LIVE_BUFFER_LIMIT = 16;
export const WEBGL_CONTEXT_LIMIT = 5;

export type BufferCandidate = {
  leafId: number | null;
  retainedLeafId: number | null;
  protected: boolean;
  visible: boolean;
  lastUsedAt: number;
};

export function chooseTerminalBuffer(
  candidates: readonly BufferCandidate[],
  leafId: number,
): number | "create" | "full" {
  const own = candidates.findIndex(
    (c) => c.leafId === leafId || c.retainedLeafId === leafId,
  );
  if (own >= 0) return own;
  const clean = candidates.findIndex(
    (c) => c.leafId === null && c.retainedLeafId === null && !c.protected,
  );
  if (clean >= 0) return clean;
  if (candidates.length < WARM_BUFFER_LIMIT) return "create";
  let best = -1;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (c.protected || c.visible) continue;
    if (best < 0 || c.lastUsedAt < candidates[best].lastUsedAt) best = i;
  }
  if (best >= 0) return best;
  return candidates.length < LIVE_BUFFER_LIMIT ? "create" : "full";
}
