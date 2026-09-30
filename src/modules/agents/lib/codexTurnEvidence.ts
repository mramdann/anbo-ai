import type { TurnEvidence } from "./agentScreenClassifier";

type Evidence = { since: number; started: number; finished: number };
const entries = new Map<number, Evidence>();
const inputs = new Map<number, number>();

export const codexTurnEvidence = {
  start(leaf: number, since: number) {
    entries.set(leaf, {
      since: Math.max(since, inputs.get(leaf) ?? 0),
      started: 0,
      finished: 0,
    });
  },
  stop(leaf: number) {
    entries.delete(leaf);
    inputs.delete(leaf);
  },
  clear() {
    entries.clear();
    inputs.clear();
  },
  input(leaf: number, data: string, attention = false, now = Date.now()) {
    const entry = entries.get(leaf);
    if (!/[\r\n]/.test(data)) return false;
    if (!attention) inputs.set(leaf, now);
    if (!entry) return true;
    if (!attention) entry.since = now;
    entry.finished = 0;
    return false;
  },
  receive(leaf: number, value: unknown) {
    const entry = entries.get(leaf);
    if (!entry) return;
    if (!value || typeof value !== "object") {
      entry.finished = 0;
      return;
    }
    const turn = value as { startedAt?: string; finishedAt?: string };
    const started = Date.parse(turn.startedAt ?? "");
    if (!Number.isFinite(started) || started < entry.started) return;
    entry.started = started;
    const finished = Date.parse(turn.finishedAt ?? "");
    entry.finished =
      Number.isFinite(finished) && finished >= started ? finished : 0;
  },
  completed(leaf?: number) {
    return this.state(leaf) === "complete";
  },
  /**
   * What the rollout says about the turn since the last submitted input: still
   * open, finished, or nothing yet (no watcher, or no turn recorded since).
   */
  state(leaf?: number): TurnEvidence {
    const entry = leaf === undefined ? undefined : entries.get(leaf);
    if (!entry || entry.started <= 0 || entry.started < entry.since)
      return null;
    return entry.finished >= entry.started && entry.finished > 0
      ? "complete"
      : "running";
  },
};
