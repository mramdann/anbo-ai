import type { Extension } from "@codemirror/state";
import { ViewPlugin } from "@codemirror/view";

/** On the scroller of an editor whose caret a timer blinks. */
export const CARET_TIMED_CLASS = "cm-caret-timed";
/** On that scroller for the dark half of a blink. */
export const CARET_OFF_CLASS = "cm-caret-off";
/** CodeMirror's own rate: one blink in 1.2 s, the caret shown for its first half. */
const CARET_BLINK_MS = 1200;

/** What the blink reads of its editor. */
type CaretView = {
  readonly hasFocus: boolean;
  readonly scrollDOM: {
    readonly classList: Pick<DOMTokenList, "add" | "remove" | "toggle">;
  };
};

type CaretUpdate = {
  readonly focusChanged: boolean;
  readonly selectionSet: boolean;
};

/**
 * The blink for one editor, apart from CodeMirror's plugin machinery. The
 * caret is shown, and for as long as the editor holds the focus it is hidden
 * and shown again every half blink. It starts over, shown, when the focus
 * comes or goes and when a transaction sets the selection: that is when
 * CodeMirror started its own animation over. A rate of 0 is CodeMirror's
 * "no blinking".
 */
export function blinkCaret(view: CaretView, blinkMs: number) {
  const scroller = view.scrollDOM.classList;
  let timer: ReturnType<typeof setInterval> | undefined;
  const rest = () => {
    clearInterval(timer);
    timer = undefined;
    scroller.remove(CARET_OFF_CLASS);
  };
  const start = () => {
    rest();
    if (blinkMs <= 0 || !view.hasFocus) return;
    timer = setInterval(() => {
      scroller.toggle(CARET_OFF_CLASS);
    }, blinkMs / 2);
  };
  scroller.add(CARET_TIMED_CLASS);
  start();
  return {
    update(update: CaretUpdate) {
      if (update.focusChanged || update.selectionSet) start();
    },
    destroy() {
      rest();
      scroller.remove(CARET_TIMED_CLASS);
    },
  };
}

/**
 * Blinks an editor's caret from a timer instead of CodeMirror's CSS animation.
 * An animation that never ends keeps Chromium making frames 60 times a second
 * for a caret that changes twice in 1.2 s: about 1.3% of a core for as long as
 * an editor holds the focus (round 109). `globals.css` turns the animation off
 * for a scroller with `cm-caret-timed` and gives its cursor layers, vim's
 * block cursor among them, no opacity while it has `cm-caret-off`. The pixels
 * stay what the animation drew, in both halves (round 110). An editor without
 * this plugin keeps the animation.
 */
export function caretBlink(blinkMs = CARET_BLINK_MS): Extension {
  return ViewPlugin.define((view) => blinkCaret(view, blinkMs));
}
