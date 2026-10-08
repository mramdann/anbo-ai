import { invoke } from "@tauri-apps/api/core";
import {
  Component,
  type ErrorInfo,
  type ReactNode,
  useLayoutEffect,
} from "react";

export function StartupReady({ children }: { children: ReactNode }) {
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

export class RootErrorBoundary extends Component<
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
