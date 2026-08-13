import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { useCallback, useEffect, useState } from "react";
import { IS_WINDOWS } from "@/lib/platform";

const LAST_CHECK_KEY = "anbo:updater:last-check";
const DISMISSED_VERSION_KEY = "anbo:updater:dismissed-version";
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
 * Whether an available update should be surfaced to the user. Automatic polling
 * suppresses a version the user explicitly deferred with "Later"; a manual check
 * always shows it, and any newer version (different version string) re-arms it.
 */
export function shouldShowUpdate(
  foundVersion: string,
  dismissedVersion: string | null,
  manual?: boolean,
): boolean {
  if (manual) return true;
  return foundVersion !== dismissedVersion;
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
    const dismissedVersion = localStorage.getItem(DISMISSED_VERSION_KEY);
    try {
      const update = await check();
      if (update) {
        if (!shouldShowUpdate(update.version, dismissedVersion, manual)) {
          // Deferred this exact version; stay quiet until a newer one ships.
          setStatus({ kind: "idle" });
          return;
        }
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

  const dismiss = useCallback(() => {
    if (status.kind === "available") {
      localStorage.setItem(DISMISSED_VERSION_KEY, status.update.version);
    }
    setStatus({ kind: "idle" });
  }, [status]);

  useEffect(() => {
    if (!autoCheck || !IS_WINDOWS) return;
    void runCheck();
    const interval = window.setInterval(() => {
      void runCheck();
    }, CHECK_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [autoCheck, runCheck]);

  return { status, check: runCheck, install, dismiss };
}
