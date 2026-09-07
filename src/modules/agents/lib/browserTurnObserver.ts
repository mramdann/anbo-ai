import {
  acceptsAutomationState,
  parseAutomationState,
  type AutomationState,
} from "@/modules/browser/automationState";
import { classifyAgentTurn } from "./agentScreenClassifier";
import { AgentScreenObserver } from "./agentScreenObserver";

export type BrowserTurnEnd = {
  ptyId: number;
  tabId: number;
  controlId: number;
  sequence: number;
};
type Control = { state: AutomationState; ptyId: number | null };

/** Uses the existing terminal sampling tick. No new timer, terminal read, or
 * status-store write. Transport ownership is supplied only by the backend.
 */
export class BrowserTurnObserver {
  private readonly observer = new AgentScreenObserver(classifyAgentTurn);
  private readonly leaves = new Map<number, number>();
  private readonly controls = new Map<number, Control>();

  start(leafId: number, ptyId: number, agent: string): void {
    if (this.leaves.get(ptyId) === leafId) return;
    this.stop(leafId);
    this.leaves.set(ptyId, leafId);
    this.observer.start(leafId, ptyId, agent);
  }

  stop(leafId: number): void {
    this.observer.stop(leafId);
    for (const [ptyId, leaf] of this.leaves) {
      if (leaf === leafId) {
        this.leaves.delete(ptyId);
        for (const [tabId, control] of this.controls) {
          if (control.ptyId === ptyId) this.controls.delete(tabId);
        }
      }
    }
  }

  input(leafId: number, data: string, now = Date.now()): void {
    this.observer.input(leafId, data, now);
  }

  retainTabs(tabIds: ReadonlySet<number>): void {
    for (const tabId of this.controls.keys()) {
      if (!tabIds.has(tabId)) this.controls.delete(tabId);
    }
  }

  receive(payload: unknown, now = Date.now()): void {
    const state = parseAutomationState(payload);
    if (!state) return;
    const previous = this.controls.get(state.tabId);
    if (!acceptsAutomationState(previous?.state ?? null, state)) return;
    const rawPty = (payload as { ptyId?: unknown }).ptyId;
    const ptyId =
      typeof rawPty === "number" && Number.isSafeInteger(rawPty) && rawPty > 0
        ? rawPty
        : null;
    if (state.phase === "ended" || ptyId === null || !this.leaves.has(ptyId)) {
      this.controls.delete(state.tabId);
      return;
    }
    if (!previous && this.controls.size >= 256) return;
    this.controls.set(state.tabId, { state, ptyId });
    const leaf = ptyId === null ? undefined : this.leaves.get(ptyId);
    if (
      leaf !== undefined &&
      (state.requestId !== previous?.state.requestId ||
        ["done", "error"].includes(state.phase))
    ) {
      this.observer.activity(leaf, now);
    }
  }

  poll(
    read: (leafId: number) => string | null,
    now = Date.now(),
  ): BrowserTurnEnd[] {
    const result: BrowserTurnEnd[] = [];
    if (!this.controls.size) return result;
    const activeLeaves = new Set(
      [...this.controls.values()].flatMap(({ ptyId }) => {
        const leaf = ptyId === null ? undefined : this.leaves.get(ptyId);
        return leaf === undefined ? [] : [leaf];
      }),
    );
    for (const signal of this.observer.poll(
      (leaf) => (activeLeaves.has(leaf) ? read(leaf) : null),
      now,
    )) {
      if (signal.kind !== "ready" && signal.kind !== "finished") continue;
      for (const { state, ptyId } of this.controls.values()) {
        if (
          ptyId === signal.ptyId &&
          state.controlId &&
          ["done", "error"].includes(state.phase)
        ) {
          result.push({
            ptyId,
            tabId: state.tabId,
            controlId: state.controlId,
            sequence: state.sequence,
          });
        }
      }
    }
    return result;
  }
}
