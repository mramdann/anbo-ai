/**
 * Puts the pages a user is looking at ahead of native work that can wait.
 *
 * The shell builds native windows and webviews on one UI thread, one at a time.
 * The AnboVoice orb is a webview window of its own: built while a reopened
 * workspace was putting its browser pages up, it kept a restored page off
 * screen for seconds. Browser panes report their page work here, and the orb
 * waits until the restored workspace has been handed out and that work has
 * gone quiet.
 */

const QUIET_MS = 1_000;
// Only for work that never reports back; the orb is never held longer.
const MAX_WAIT_MS = 15_000;

export function createNativeWorkOrder(
  quietMs = QUIET_MS,
  maxWaitMs = MAX_WAIT_MS,
) {
  let restored = false;
  let pageWork = 0;
  let quiet: ReturnType<typeof setTimeout> | null = null;
  const waiters = new Set<() => void>();

  const release = () => {
    quiet = null;
    if (!restored || pageWork > 0) return;
    for (const finish of [...waiters]) finish();
  };

  // The restore hands its tabs out before any pane has mounted, so the quiet
  // window also covers the renders between the two.
  const settle = () => {
    if (quiet !== null) clearTimeout(quiet);
    quiet = null;
    if (!restored || pageWork > 0 || waiters.size === 0) return;
    quiet = setTimeout(release, quietMs);
  };

  return {
    markWorkspaceRestored(): void {
      restored = true;
      settle();
    },
    beginPageWork(): () => void {
      pageWork += 1;
      settle();
      let done = false;
      return () => {
        if (done) return;
        done = true;
        pageWork -= 1;
        settle();
      };
    },
    afterPageWork(): Promise<void> {
      return new Promise((resolve) => {
        const finish = () => {
          clearTimeout(cap);
          waiters.delete(finish);
          resolve();
        };
        const cap = setTimeout(finish, maxWaitMs);
        waiters.add(finish);
        settle();
      });
    },
  };
}

const order = createNativeWorkOrder();

/** The launch restore has handed out its tabs, or found none to hand out. */
export const markWorkspaceRestored = order.markWorkspaceRestored;
/** A browser pane is putting its page up; call the result when it is done. */
export const beginPageWork = order.beginPageWork;
/** Resolves once the restore is out and page work has gone quiet. */
export const afterPageWork = order.afterPageWork;
