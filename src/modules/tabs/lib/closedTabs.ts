/**
 * Tabs closed one at a time on purpose: by the user (the X, Ctrl+W, a close
 * the tab menu offers) or by an agent. A workspace that is deleted or reset
 * takes its tabs along without closing them this way. The Chrome/Edge sync
 * closes the browser's own tab only for a tab closed on purpose; any other
 * end lets the page go back to the browser.
 */

/** The newest closes kept: a tab's close is taken right after it. */
const LIMIT = 256;

const closed = new Set<number>();

export function noteTabClosed(id: number): void {
  closed.delete(id);
  closed.add(id);
  if (closed.size > LIMIT) {
    const oldest = closed.values().next().value;
    if (oldest !== undefined) closed.delete(oldest);
  }
}

/** Whether the tab was closed on purpose; forgets it either way. */
export function takeTabClosed(id: number): boolean {
  return closed.delete(id);
}
