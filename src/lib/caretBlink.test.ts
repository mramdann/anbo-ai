import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { blinkCaret, CARET_OFF_CLASS, CARET_TIMED_CLASS } from "./caretBlink";

/** An editor as far as the blink reads it: its focus and its scroller's classes. */
function editor(hasFocus: boolean) {
  const classes = new Set<string>();
  const view = {
    hasFocus,
    scrollDOM: {
      classList: {
        add: (name: string) => {
          classes.add(name);
        },
        remove: (name: string) => {
          classes.delete(name);
        },
        toggle: (name: string) => {
          if (classes.delete(name)) return false;
          classes.add(name);
          return true;
        },
      },
    },
  };
  return { view, shown: () => !classes.has(CARET_OFF_CLASS), classes };
}

const MOVED = { focusChanged: false, selectionSet: true };
const FOCUS = { focusChanged: true, selectionSet: false };
const OTHER = { focusChanged: false, selectionSet: false };

describe("caretBlink", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("marks its scroller and runs no timer for an editor without the focus", () => {
    const { view, shown, classes } = editor(false);
    blinkCaret(view, 1200);

    expect(classes.has(CARET_TIMED_CLASS)).toBe(true);
    expect(shown()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(5_000);
    expect(shown()).toBe(true);
  });

  // CodeMirror's animation: shown for the first half of 1.2 s, hidden for the
  // second, without end.
  it("hides and shows the caret every half blink while the editor holds the focus", () => {
    const { view, shown } = editor(false);
    const blink = blinkCaret(view, 1200);
    view.hasFocus = true;
    blink.update(FOCUS);

    expect(shown()).toBe(true);
    vi.advanceTimersByTime(599);
    expect(shown()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(shown()).toBe(false);
    vi.advanceTimersByTime(599);
    expect(shown()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(shown()).toBe(true);
    vi.advanceTimersByTime(600);
    expect(shown()).toBe(false);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("blinks at once for an editor that is made with the focus", () => {
    const { view, shown } = editor(true);
    blinkCaret(view, 1200);

    vi.advanceTimersByTime(600);
    expect(shown()).toBe(false);
  });

  it("shows the caret at once and starts the blink over when the caret moves", () => {
    const { view, shown } = editor(true);
    const blink = blinkCaret(view, 1200);
    vi.advanceTimersByTime(700);
    expect(shown()).toBe(false);

    blink.update(MOVED);
    expect(shown()).toBe(true);
    vi.advanceTimersByTime(599);
    expect(shown()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(shown()).toBe(false);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("leaves the blink alone for an update that moves neither caret nor focus", () => {
    const { view, shown } = editor(true);
    const blink = blinkCaret(view, 1200);
    vi.advanceTimersByTime(300);

    blink.update(OTHER);
    vi.advanceTimersByTime(300);
    expect(shown()).toBe(false);
  });

  it("rests with the caret shown when the focus leaves in the dark half", () => {
    const { view, shown } = editor(true);
    const blink = blinkCaret(view, 1200);
    vi.advanceTimersByTime(700);
    expect(shown()).toBe(false);

    view.hasFocus = false;
    blink.update(FOCUS);
    expect(shown()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(5_000);
    expect(shown()).toBe(true);

    // A caret that moves in an editor without the focus wakes nothing.
    blink.update(MOVED);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the rate it is given", () => {
    const { view, shown } = editor(true);
    blinkCaret(view, 1100);

    vi.advanceTimersByTime(549);
    expect(shown()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(shown()).toBe(false);
  });

  it("does not blink at a rate of zero", () => {
    const { view, shown } = editor(true);
    blinkCaret(view, 0);

    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(5_000);
    expect(shown()).toBe(true);
  });

  it("leaves no class and no timer behind when the editor goes", () => {
    const { view, classes } = editor(true);
    const blink = blinkCaret(view, 1200);
    vi.advanceTimersByTime(700);

    blink.destroy();
    expect([...classes]).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
