/** Tabs whose agent open still reads the new page (browser_open with find).
 * Docking now would move the page under that read, and Chrome holds a moving
 * tab's commands until the move is done: such an open took about three times
 * as long. The find runs on the page where the browser opened it, and the dock
 * waits for the read, or for OPEN_READ_LIMIT_MS at most. */
const reading = new Map<number, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();

/** A read that takes longer gives way: the page docks and shows as before. */
export const OPEN_READ_LIMIT_MS = 1_000;

function changed() {
  for (const notify of listeners) notify();
}

export function holdDockForOpenRead(
  tabId: number,
  limit = OPEN_READ_LIMIT_MS,
): void {
  clearTimeout(reading.get(tabId));
  reading.set(
    tabId,
    setTimeout(() => releaseDockForOpenRead(tabId), limit),
  );
  changed();
}

export function releaseDockForOpenRead(tabId: number): void {
  const timer = reading.get(tabId);
  if (timer === undefined) return;
  clearTimeout(timer);
  reading.delete(tabId);
  changed();
}

export function openReadHoldsDock(tabId: number): boolean {
  return reading.has(tabId);
}

export function subscribeOpenReads(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
