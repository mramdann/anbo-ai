import type { Update } from "@tauri-apps/plugin-updater";
import { useCallback, useEffect, useState } from "react";
import { IS_WINDOWS } from "@/lib/platform";

const LAST_CHECK_KEY = "anbo:updater:last-check";
const CHECK_INTERVAL_MS = 30 * 60 * 1000;
export type UpdaterStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "uptodate" }
  | { kind: "unsupported" }
  | { kind: "available"; update: Update }
  | { kind: "downloading"; downloaded: number; contentLength: number | null }
  | { kind: "ready" }
  | { kind: "error"; message: string };

function parseVersion(v: string): number[] {
  return v
    .replace(/^v/, "")
    .split("-")[0]
    .split(".")
    .map((p) => Number.parseInt(p, 10) || 0);
}

export function isNewer(remote: string, current: string): boolean {
  const a = parseVersion(remote);
  const b = parseVersion(current);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

/**
 * Whether the header should carry the update button.
 *
 * A download in flight and a finished one both keep it: the button is the only
 * way back to the dialog, and losing it mid-update would strand the user with
 * no way to see progress or restart.
 */
export function shouldOfferUpdate(status: UpdaterStatus): boolean {
  return (
    status.kind === "available" ||
    status.kind === "downloading" ||
    status.kind === "ready"
  );
}

export function isUpdaterPlatformSupported(platform: string): boolean {
  return platform === "windows";
}

interface Options {
  /** Skip the time-based throttle on automatic startup checks. */
  manual?: boolean;
}

interface HookOptions {
  /** When false, the hook does not run an automatic check on mount. */
  autoCheck?: boolean;
}

export function useUpdater({ autoCheck = true }: HookOptions = {}) {
  const [status, setStatus] = useState<UpdaterStatus>({ kind: "idle" });

  const runCheck = useCallback(async ({ manual }: Options = {}) => {
    if (!IS_WINDOWS) {
      setStatus({ kind: "unsupported" });
      return;
    }
    if (!manual) {
      const last = Number(localStorage.getItem(LAST_CHECK_KEY) ?? 0);
      if (Date.now() - last < CHECK_INTERVAL_MS) return;
    }
    setStatus({ kind: "checking" });
    try {
      // Loaded on use. Neither plugin is needed to draw the app, and carrying
      // them through the header would put them in the startup budget for a
      // check that happens once every thirty minutes.
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      if (update) {
        // Nothing here interrupts anyone: an available update only lights the
        // button in the header, and the user opens it when they choose to.
        setStatus({ kind: "available", update });
      } else {
        localStorage.setItem(LAST_CHECK_KEY, String(Date.now()));
        setStatus({ kind: "uptodate" });
      }
    } catch (err) {
      setStatus({ kind: "error", message: String(err) });
    }
  }, []);

  const install = useCallback(async () => {
    if (status.kind !== "available") return;
    const { update } = status;
    let total: number | null = null;
    let downloaded = 0;
    setStatus({ kind: "downloading", downloaded: 0, contentLength: null });
    try {
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength ?? null;
          setStatus({
            kind: "downloading",
            downloaded: 0,
            contentLength: total,
          });
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          setStatus({ kind: "downloading", downloaded, contentLength: total });
        } else if (event.event === "Finished") {
          setStatus({ kind: "ready" });
        }
      });
      await relaunch();
    } catch (err) {
      setStatus({ kind: "error", message: String(err) });
    }
  }, [status]);

  useEffect(() => {
    if (!autoCheck || !IS_WINDOWS) return;
    void runCheck();
    const interval = window.setInterval(() => {
      void runCheck();
    }, CHECK_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [autoCheck, runCheck]);

  return { status, check: runCheck, install };
}
