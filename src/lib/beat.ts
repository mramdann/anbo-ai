/** On an indicator the shared beat holds at its low level. */
export const BEAT_ATTRIBUTE = "data-beat";
/** On an element whose animation runs one pass at a time: "a" or "b". */
export const PASS_ATTRIBUTE = "data-pass";
/** A beat stays this long at each of its two levels. */
const BEAT_MS = 1000;

type Marked = Pick<Element, "setAttribute" | "removeAttribute">;

const beating = new Set<Marked>();
let low = false;
let beatTimer: ReturnType<typeof setInterval> | undefined;

function show(element: Marked) {
  if (low) element.setAttribute(BEAT_ATTRIBUTE, "low");
  else element.removeAttribute(BEAT_ATTRIBUTE);
}

/**
 * A ref for an indicator that beats: two levels, switched once a second by one
 * timer for all of them, so the window draws one frame a second however many
 * show. A pulse by an animation that never ends drew it at the display rate:
 * a working agent's 6 px badge cost about 3% of a core in the renderer and 7%
 * over all of the app's processes (round 111). The timer runs only while
 * something beats.
 */
export function joinBeat(element: Marked | null) {
  if (!element) return;
  beating.add(element);
  show(element);
  beatTimer ??= setInterval(() => {
    low = !low;
    for (const member of beating) show(member);
  }, BEAT_MS);
  return () => {
    beating.delete(element);
    element.removeAttribute(BEAT_ATTRIBUTE);
    if (beating.size > 0) return;
    clearInterval(beatTimer);
    beatTimer = undefined;
    low = false;
  };
}

/**
 * A ref for an element whose animation runs one pass now and one every
 * `everyMs` after. The mark flips between two values that name the same
 * keyframes twice, which starts the animation over; between passes nothing
 * animates. One animation that never ends keeps the renderer drawing at the
 * display rate through the rests in its own keyframes (round 110).
 */
export function passesEvery(everyMs: number) {
  return (element: Marked | null) => {
    if (!element) return;
    let pass = "b";
    const run = () => {
      pass = pass === "a" ? "b" : "a";
      element.setAttribute(PASS_ATTRIBUTE, pass);
    };
    run();
    const timer = setInterval(run, everyMs);
    return () => {
      clearInterval(timer);
      element.removeAttribute(PASS_ATTRIBUTE);
    };
  };
}
