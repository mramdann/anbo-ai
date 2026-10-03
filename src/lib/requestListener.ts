type RequestHandler<T> = (request: T) => void;
type RequestSubscribe<T> = (handler: RequestHandler<T>) => Promise<() => void>;

export type RequestListener<T> = {
  setHandler(next: RequestHandler<T>): void;
  stop(): void;
};

/**
 * One subscription that hands each request to the latest handler. A
 * subscription that resolves after `stop()` is disposed, and it never clears
 * the one a later `setHandler` started, so a quick stop and restart cannot
 * leave two listeners behind.
 */
export function createRequestListener<T>(
  subscribe: RequestSubscribe<T>,
): RequestListener<T> {
  let handler: RequestHandler<T> | null = null;
  let subscription: Promise<void> | null = null;
  let unlisten: (() => void) | null = null;
  let generation = 0;

  const start = () => {
    if (subscription || unlisten) return;
    const currentGeneration = generation;
    subscription = subscribe((request) => handler?.(request))
      .then((dispose) => {
        if (generation !== currentGeneration) {
          dispose();
          return;
        }
        subscription = null;
        unlisten = dispose;
      })
      .catch(() => {
        if (generation === currentGeneration) subscription = null;
      });
  };

  return {
    setHandler(next) {
      handler = next;
      start();
    },
    stop() {
      generation += 1;
      handler = null;
      unlisten?.();
      unlisten = null;
      subscription = null;
    },
  };
}
