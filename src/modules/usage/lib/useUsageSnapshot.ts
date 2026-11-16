import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import type { UsageSnapshot } from "./usageModel";

/** How often the usage view reads while it is open. */
export const USAGE_INTERVAL_MS = 2000;
/** The second read comes sooner: the first one has no CPU figures yet. */
const SECOND_READ_MS = 700;

/**
 * Reads what Anbo's processes use while its component is mounted (the usage
 * view's body, so only while the view is open), every couple of seconds. A
 * hidden window (minimized) skips its reads.
 */
export function useUsageSnapshot(): UsageSnapshot | null {
  const [snapshot, setSnapshot] = useState<UsageSnapshot | null>(null);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reads = 0;
    const tick = async () => {
      if (!document.hidden) {
        try {
          const next = await invoke<UsageSnapshot>("usage_snapshot");
          if (cancelled) return;
          setSnapshot(next);
          reads += 1;
        } catch {
          // The next read tries again.
        }
      }
      if (!cancelled) {
        timer = setTimeout(
          tick,
          reads === 1 ? SECOND_READ_MS : USAGE_INTERVAL_MS,
        );
      }
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, []);
  return snapshot;
}
