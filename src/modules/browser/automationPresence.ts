import {
  acceptsAutomationState,
  type AutomationState,
} from "./automationState";

const EMPTY: readonly AutomationState[] = [];
const MAX_TABS = 256;
const MAX_CONTROLS = 64;

export class AutomationPresence {
  private readonly tabs = new Map<number, Map<number, AutomationState>>();
  private readonly focus = new Map<
    number,
    { tabId: number; requestId: number }
  >();
  private readonly snapshots = new Map<number, readonly AutomationState[]>();
  private readonly listeners = new Map<number, Set<() => void>>();

  get(tabId: number): readonly AutomationState[] {
    return this.snapshots.get(tabId) ?? EMPTY;
  }

  subscribe(tabId: number, listener: () => void): () => void {
    let listeners = this.listeners.get(tabId);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(tabId, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(tabId);
    };
  }

  receive(state: AutomationState): void {
    const id = state.controlId;
    if (!id) return;
    let tab = this.tabs.get(state.tabId);
    if (!tab) {
      if (this.tabs.size >= MAX_TABS) return;
      tab = new Map();
      this.tabs.set(state.tabId, tab);
    }
    const previous = tab.get(id);
    if (!acceptsAutomationState(previous ?? null, state)) return;
    if (!previous && tab.size >= MAX_CONTROLS) {
      const oldest = [...tab.values()].sort(
        (a, b) =>
          Number(a.phase !== "ended") - Number(b.phase !== "ended") ||
          a.sequence - b.sequence,
      )[0];
      if (oldest?.controlId) tab.delete(oldest.controlId);
    }
    tab.set(id, state);
    const focused = this.focus.get(id);
    if (
      state.phase !== "ended" &&
      (!focused || state.requestId > focused.requestId)
    ) {
      this.focus.delete(id);
      this.focus.set(id, { tabId: state.tabId, requestId: state.requestId });
      if (this.focus.size > MAX_CONTROLS) {
        const first = this.focus.keys().next().value;
        if (first !== undefined) {
          const old = this.focus.get(first);
          this.focus.delete(first);
          if (old) this.refresh(old.tabId);
        }
      }
    }
    if (focused && focused.tabId !== state.tabId) this.refresh(focused.tabId);
    this.refresh(state.tabId);
  }

  clear(tabId: number): void {
    this.tabs.delete(tabId);
    for (const [id, current] of this.focus) {
      if (current.tabId === tabId) this.focus.delete(id);
    }
    this.refresh(tabId);
  }

  private refresh(tabId: number): void {
    const next = [...(this.tabs.get(tabId)?.values() ?? [])]
      .filter(
        (state) =>
          state.phase !== "ended" &&
          this.focus.get(state.controlId ?? 0)?.tabId === tabId,
      )
      .sort((a, b) => (a.controlId ?? 0) - (b.controlId ?? 0));
    const previous = this.get(tabId);
    if (
      previous.length === next.length &&
      previous.every((state, i) => state === next[i])
    )
      return;
    if (next.length) this.snapshots.set(tabId, next);
    else this.snapshots.delete(tabId);
    for (const listener of this.listeners.get(tabId) ?? []) listener();
  }
}
