import { useRef, useState } from "react";

type AnyFunction = (...args: never[]) => unknown;

/** A function with one identity for the component's lifetime that runs the
 *  latest `fn`. V8 gives every closure a render makes that render's context,
 *  so a useCallback kept from an older render tied each new render to the
 *  older ones and App's whole render history stayed reachable (round 90,
 *  R87-2). `fn` is swapped while the component renders, so children that
 *  render after it already call the new one. */
export function useStableCallback<T extends AnyFunction>(fn: T): T {
  const latest = useRef(fn);
  latest.current = fn;
  const [stable] = useState(() => forwardTo(latest));
  return stable;
}

/** Calls whatever `latest` holds now. Made outside any render, so it keeps
 *  the ref alive and nothing else. */
export function forwardTo<T extends AnyFunction>(latest: {
  readonly current: T;
}): T {
  const forward = (...args: unknown[]) =>
    (latest.current as unknown as (...forwarded: unknown[]) => unknown)(
      ...args,
    );
  return forward as unknown as T;
}
