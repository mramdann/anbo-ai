import { invoke } from "@tauri-apps/api/core";
import { useEffect, useSyncExternalStore } from "react";

/**
 * What Anbo knows about the program a start command runs.
 *
 * "unknown" is an answer in its own right, not a stand-in for "missing": the
 * probe lands a moment after the first paint, and a bench that greyed itself
 * out for those frames would flicker every time it opened.
 */
export type AgentCliAvailability = "ready" | "missing" | "unknown";

export type AgentCliProbe = { installed: boolean; at: number };
export type AgentCliProbes = Readonly<Record<string, AgentCliProbe>>;

/**
 * How long an answer is trusted. Long enough that opening the launcher twice
 * in a row costs one probe, short enough that installing a CLI and coming
 * back shows it ready without Anbo having to be restarted.
 */
export const AGENT_CLI_PROBE_TTL_MS = 30_000;

/**
 * Reading an answer ignores its age on purpose. Staleness decides when to ask
 * again; letting it decide what to show would drop the whole bench back to
 * "unknown" thirty seconds after the last probe, with nothing on screen having
 * changed.
 */
export function agentCliAvailability(
  probes: AgentCliProbes,
  command: string,
): AgentCliAvailability {
  const probe = probes[command];
  if (!probe) return "unknown";
  return probe.installed ? "ready" : "missing";
}

/**
 * The bench with what cannot run yet moved to the end, each group keeping the
 * order it was declared in.
 *
 * A CLI Anbo supports but the user has not installed still belongs on the
 * bench -- that is how they learn it is supported at all -- but it should not
 * sit between two agents they can actually pick. A stable partition rather
 * than a sort, so nothing else shuffles when one answer arrives.
 */
export function benchOrder<T>(
  items: readonly T[],
  availabilityOf: (item: T) => AgentCliAvailability,
): T[] {
  const runnable: T[] = [];
  const missing: T[] = [];
  for (const item of items) {
    (availabilityOf(item) === "missing" ? missing : runnable).push(item);
  }
  return [...runnable, ...missing];
}

/**
 * The commands worth asking about: anything runnable whose answer is missing
 * or has gone stale. An empty command has no program to look for, and asking
 * twice for the same one in a single pass wastes a PATH walk.
 */
export function staleAgentCliCommands(
  commands: readonly string[],
  probes: AgentCliProbes,
  now: number = Date.now(),
): string[] {
  const wanted = new Set<string>();
  for (const command of commands) {
    if (!command.trim()) continue;
    const probe = probes[command];
    if (!probe || now - probe.at >= AGENT_CLI_PROBE_TTL_MS) wanted.add(command);
  }
  return [...wanted];
}

let probes: AgentCliProbes = {};
const listeners = new Set<() => void>();
const inFlight = new Set<string>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): AgentCliProbes {
  return probes;
}

/** Everything Anbo has been told so far, outside a React render. */
export function agentCliProbes(): AgentCliProbes {
  return probes;
}

/** Test seam: drop every answer so the next probe starts from nothing. */
export function forgetAgentCliStatus(): void {
  probes = {};
  inFlight.clear();
  for (const listener of listeners) listener();
}

export async function probeAgentClis(
  commands: readonly string[],
): Promise<void> {
  const wanted = staleAgentCliCommands(commands, probes).filter(
    (command) => !inFlight.has(command),
  );
  if (wanted.length === 0) return;
  for (const command of wanted) inFlight.add(command);
  try {
    const found = await invoke<Record<string, boolean>>("agent_cli_status", {
      commands: wanted,
    });
    const at = Date.now();
    const next = { ...probes };
    for (const command of wanted) {
      next[command] = { installed: found[command] === true, at };
    }
    probes = next;
    for (const listener of listeners) listener();
  } catch (error) {
    // A failed probe leaves every answer "unknown", which shows the bench the
    // way it looked before this feature existed rather than greying it out.
    console.warn(
      "[anbo] could not check which agent CLIs are installed:",
      error,
    );
  } finally {
    for (const command of wanted) inFlight.delete(command);
  }
}

/**
 * Answers for these commands, probing the ones Anbo has not looked up lately.
 * The commands are joined into the effect key so a re-render with the same
 * bench does not start the walk again.
 */
export function useAgentCliStatus(commands: readonly string[]): AgentCliProbes {
  const known = useSyncExternalStore(subscribe, snapshot, snapshot);
  const key = commands.filter((command) => command.trim()).join("\n");
  useEffect(() => {
    if (!key) return;
    void probeAgentClis(key.split("\n"));
  }, [key]);
  return known;
}
