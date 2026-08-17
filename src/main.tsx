import "@xterm/xterm/css/xterm.css";
import "sonner/dist/styles.css";
import "./styles/globals.css";

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Component,
  type ErrorInfo,
  type ReactNode,
  useLayoutEffect,
} from "react";
import ReactDOM from "react-dom/client";
import App from "./app/App";
import { initLaunchDir } from "./lib/launchDir";
import { USE_CUSTOM_WINDOW_CONTROLS } from "./lib/platform";
import { initializeWindowPresentation } from "./lib/windowPresentation";

if (USE_CUSTOM_WINDOW_CONTROLS) {
  document.documentElement.dataset.chrome = "borderless";
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

function StartupReady({ children }: { children: ReactNode }) {
  useLayoutEffect(() => {
    document.documentElement.dataset.anboBundleReady = "true";
    window.dispatchEvent(new CustomEvent("anbo:startup-ready"));
    if (import.meta.env.PROD && "__TAURI_INTERNALS__" in window) {
      void invoke("packaged_smoke_ready").catch((error) =>
        console.error("[anbo] packaged startup smoke signal failed", error),
      );
    }
  }, []);
  return children;
}

type RootErrorBoundaryState = { error: Error | null };

class RootErrorBoundary extends Component<
  { children: ReactNode },
  RootErrorBoundaryState
> {
  state: RootErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): RootErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[anbo] React root failed:", error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    const detail = String(this.state.error.stack ?? this.state.error).slice(
      0,
      1_500,
    );
    return (
      <main className="flex h-full items-center justify-center bg-background p-6 text-foreground">
        <section className="w-full max-w-2xl rounded-xl border border-destructive/40 bg-card p-5 shadow-xl">
          <h1 className="text-base font-semibold">
            Anbo could not open this workspace
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Your workspace data is still preserved. Restart Anbo after reporting
            the error below.
          </p>
          <pre
            data-testid="root-error-detail"
            className="mt-4 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted p-3 text-xs"
          >
            {detail}
          </pre>
        </section>
      </main>
    );
  }
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
