import "@xterm/xterm/css/xterm.css";
import "sonner/dist/styles.css";
import "./styles/globals.css";

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import ReactDOM from "react-dom/client";
import App from "./app/App";
// The entry defines no components itself. A module that defines one is a
// Fast Refresh boundary, so after an edit to anything it imports, Vite would
// run the new entry inside the live page (a second React root and a second
// terminal reap) before reloading. Without one, the page reloads once.
import { RootErrorBoundary, StartupReady } from "./app/StartupRoot";
import { initLaunchDir } from "./lib/launchDir";
import { USE_CUSTOM_WINDOW_CONTROLS } from "./lib/platform";
import { initializeWindowPresentation } from "./lib/windowPresentation";
import { initializeWindowShape } from "./lib/windowShape";

if (USE_CUSTOM_WINDOW_CONTROLS) {
  document.documentElement.dataset.chrome = "borderless";
  initializeWindowShape();
}

initializeWindowPresentation();

// Render-instrumentation overlay, opt-in: `VITE_REACT_SCAN=true pnpm dev`.
// Dev-only dynamic import so it never reaches the production bundle.
if (import.meta.env.DEV && import.meta.env.VITE_REACT_SCAN === "true") {
  const { scan } = await import("react-scan");
  scan({ enabled: true });
}

const STARTUP_STEP_TIMEOUT_MS = 8_000;

function reportStartupProgress(phase: string): void {
  window.dispatchEvent(
    new CustomEvent("anbo:startup-progress", { detail: phase }),
  );
}

function withStartupTimeout<T>(label: string, promise: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(
      () => reject(new Error(`${label} timed out`)),
      STARTUP_STEP_TIMEOUT_MS,
    );
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function bootstrap(): Promise<void> {
  if (
    new URLSearchParams(window.location.search).has(
      "anbo-production-editor-smoke",
    )
  ) {
    const { default: EditorProductionSmoke } = await import(
      "./app/EditorProductionSmoke"
    );
    reportStartupProgress("rendering the production editor smoke test");
    ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
      <RootErrorBoundary>
        <StartupReady>
          <EditorProductionSmoke />
        </StartupReady>
      </RootErrorBoundary>,
    );
    return;
  }

  // Reap PTY sessions orphaned by a prior webview load before any tab spawns.
  reportStartupProgress("closing orphaned terminals");
  await withStartupTimeout(
    "Closing orphaned terminals",
    invoke("pty_close_all").catch(() => {}),
  );

  // Seed before first paint so default tab mounts at target cwd (no flicker).
  reportStartupProgress("resolving the launch workspace");
  await withStartupTimeout("Resolving launch workspace", initLaunchDir());

  reportStartupProgress("rendering the workspace");
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <RootErrorBoundary>
      <StartupReady>
        <App />
      </StartupReady>
    </RootErrorBoundary>,
  );
}

void bootstrap().catch((error) => {
  console.error("[anbo] startup failed:", error);
  window.dispatchEvent(
    new CustomEvent("anbo:startup-error", { detail: String(error) }),
  );
});

// Window starts hidden (per tauri.conf.json) so users never see a transparent
// shadow-only frame before React paints. Use setTimeout — rAF is throttled
// while the window is hidden and would never fire.
const showWindow = () => {
  getCurrentWindow()
    .show()
    .catch((e) => console.error("window.show failed:", e));
};
setTimeout(showWindow, 50);
// Safety net: if the first show somehow fails to take effect, force again.
setTimeout(showWindow, 500);
