import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { IS_WINDOWS } from "./platform";

// A borderless window paints its own rounded corners and edge (globals.css).
// Maximized, it fills the screen, where those corners would show the desktop
// at the screen's corners, so it is square and edgeless there, the way Windows
// draws its own maximized windows. The state lives on <html> as
// data-window-maximized, and the window controls read it for their icon.
let maximized = false;
let initialized = false;
const listeners = new Set<() => void>();

export function isWindowMaximized(): boolean {
  return maximized;
}

export function subscribeWindowMaximized(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** `now` asks for the window state at once; `soon` asks at most once per
 * frame, however many resize events a drag sends. An answer that a newer
 * question overtook is dropped. */
export function createMaximizedCheck(
  query: () => Promise<boolean>,
  publish: (maximized: boolean) => void,
  requestFrame: (callback: () => void) => void,
): { now: () => void; soon: () => void } {
  let scheduled = false;
  let latest = 0;
  const now = () => {
    const check = ++latest;
    query().then(
      (value) => {
        if (check === latest) publish(value);
      },
      () => {},
    );
  };
  return {
    now,
    soon: () => {
      if (scheduled) return;
      scheduled = true;
      requestFrame(() => {
        scheduled = false;
        now();
      });
    },
  };
}

function publish(value: boolean) {
  if (value === maximized) return;
  maximized = value;
  document.documentElement.toggleAttribute("data-window-maximized", value);
  for (const listener of listeners) listener();
}

export function initializeWindowShape(): void {
  if (initialized || !isTauri()) return;
  initialized = true;
  // Windows 11 rounds its own windows by 8 px; Linux keeps the 12 px corners.
  if (IS_WINDOWS) document.documentElement.dataset.windowCorners = "windows";
  const appWindow = getCurrentWindow();
  const check = createMaximizedCheck(
    () => appWindow.isMaximized(),
    publish,
    (callback) => requestAnimationFrame(callback),
  );
  void appWindow.onResized(check.soon);
  check.now();
}
