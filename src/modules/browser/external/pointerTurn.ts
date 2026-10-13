/** The Chrome/Edge tab whose agent pointer input holds Anbo's dock right now
 * (`external_front.rs` takes turns, one input at a time). Another tab taking
 * the dock meanwhile, or coming to the front of its panel, would move that
 * page out from under the click. */
let holder: number | null = null;
const listeners = new Set<() => void>();

export const POINTER_TURN_EVENT = "anbo:browser-pointer-turn";

export function setPointerTurn(tabId: number | null): void {
  if (holder === tabId) return;
  holder = tabId;
  for (const notify of listeners) notify();
}

export function pointerTurnHeld(): boolean {
  return holder !== null;
}

/** Whether another tab's pointer input holds the dock. */
export function pointerTurnElsewhere(tabId: number): boolean {
  return holder !== null && holder !== tabId;
}

export function subscribePointerTurn(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
