// CPU buffers and GPU contexts have different lifetimes. Keep the normal
// cache small, but never recycle a live TUI merely to satisfy the GPU budget.
const WARM_BUFFER_LIMIT = 5;
export const WEBGL_CONTEXT_LIMIT = 5;

// Live buffers that cannot be evicted (every running agent CLI, running
// command, full-screen program and pane on screen holds one) are bounded by
// memory, not by a fixed count. A buffer keeps its whole scrollback at 12
// bytes a cell (xterm's content, foreground and background words) on top of
// about 0.7 MB for an empty terminal. In Dev on Oct 14 2026, fifteen busy
// terminals holding 2,000 lines of 80 columns each took 2.7 MB apiece in the
// page's heap and array buffers, and the WebView2 processes grew 2.6 MB
// apiece, while each agent CLI in such a terminal uses 100 to 350 MB of its
// own. The estimate assumes a wide pane, so full buffers on a large screen
// still fit the budget.
const LIVE_BUFFER_BUDGET_BYTES = 256 * 1024 * 1024;
const BYTES_PER_CELL = 12;
const ASSUMED_COLUMNS = 200;
const ASSUMED_ROWS = 50;
const EMPTY_BUFFER_BYTES = 768 * 1024;
/** The fixed limit before October 2026; a long scrollback never lowers it. */
export const LIVE_BUFFER_FLOOR = 16;
export const LIVE_BUFFER_CEILING = 48;

/** How many live buffers the budget allows with this scrollback setting. */
export function liveBufferLimit(scrollback: number): number {
  const lines = Math.max(0, scrollback) + ASSUMED_ROWS;
  const perBuffer =
    BYTES_PER_CELL * ASSUMED_COLUMNS * lines + EMPTY_BUFFER_BYTES;
  const fits = Math.floor(LIVE_BUFFER_BUDGET_BYTES / perBuffer);
  return Math.min(LIVE_BUFFER_CEILING, Math.max(LIVE_BUFFER_FLOOR, fits));
}

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
  liveLimit = LIVE_BUFFER_FLOOR,
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
  return candidates.length < liveLimit ? "create" : "full";
}
