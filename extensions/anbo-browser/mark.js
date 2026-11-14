// The native host keeps this extension's process scheduled while Anbo is
// connected, and has to know which of the profile's extension processes that
// is. Where other extensions' processes stay around and no Connect popup is
// open, nothing it can see from outside tells them apart. So it asks: hold
// this many megabytes for a moment. The one process whose memory grows by that
// much, and shrinks again when the hold ends, is this one.

// The most the host may ask for, and how long a hold lasts when the host
// never says to let go (its connection may be gone).
const MARK_MAX_MB = 64;
const MARK_HOLD_MS = 10_000;

// Whether this browser can show a mark: the memory has to go back the moment
// the hold ends, which only ArrayBuffer.transfer does (Chrome and Edge 114
// on). Without it the memory waits for a collection, and the host, which
// watches for the shrink, is told not to ask.
export const MARKS = typeof ArrayBuffer.prototype.transfer === "function";

export function createProcessMark(setTimer = setTimeout, clearTimer = clearTimeout) {
  let held = null;

  function clear() {
    if (!held) return;
    const { buffer, timer } = held;
    held = null;
    clearTimer(timer);
    // The memory goes back at once, not at the next collection: the host
    // watches for it.
    try { buffer.transfer(0); } catch {}
  }

  return {
    // Holds `megabytes` until clear() or the hold runs out; a second hold
    // replaces the first. False for an amount out of range, or when the
    // memory is not to be had.
    set(megabytes) {
      clear();
      if (!MARKS || !Number.isSafeInteger(megabytes) || megabytes < 1 || megabytes > MARK_MAX_MB) return false;
      try {
        held = { megabytes, buffer: new ArrayBuffer(megabytes * 1024 * 1024), timer: setTimer(clear, MARK_HOLD_MS) };
      } catch {
        return false;
      }
      return true;
    },
    clear,
    held: () => held?.megabytes ?? 0,
  };
}
