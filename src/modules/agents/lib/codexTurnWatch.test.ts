import { beforeEach, describe, expect, it, vi } from "vitest";
import { codexTurnEvidence as evidence } from "./codexTurnEvidence";
import type { Tab } from "@/modules/tabs";

const state = vi.hoisted(() => ({
  sessions: { 11: { agent: "codex", startedAt: 1000 } } as Record<
    number,
    { agent: string; startedAt: number }
  >,
  calls: [] as { name: string; args: Record<string, unknown> }[],
  channels: [] as { onmessage: (v: unknown) => void }[],
}));
vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage = (_v: unknown) => {};
    constructor() {
      state.channels.push(this);
    }
  },
  invoke: (name: string, args: Record<string, unknown>) => {
    state.calls.push({ name, args });
    return Promise.resolve();
  },
}));
vi.mock("@/modules/terminal", () => ({ ptyIdForLeaf: () => 4 }));
vi.mock("../store/agentStore", () => ({
  useAgentStore: { getState: () => state },
}));
import { CodexTurnWatch } from "./codexTurnWatch";

const tabs = [
  {
    kind: "terminal",
    cwd: "D:/qa",
    paneTree: {
      kind: "leaf",
      id: 11,
      agentResume: { agent: "codex", sessionId: "one", command: "codex" },
    },
  },
] as unknown as Tab[];
beforeEach(() => {
  state.calls.length = 0;
  state.channels.length = 0;
  evidence.stop(11);
});
describe("Codex turn subscription lifetime", () => {
  it("retains one watcher through tab updates and removes it on disposal", async () => {
    const watch = new CodexTurnWatch();
    watch.sync(tabs);
    watch.sync([...tabs]);
    expect(
      state.calls.filter((c) => c.name === "anbo_watch_codex_turn"),
    ).toHaveLength(1);
    state.channels[0].onmessage({
      startedAt: new Date(2000).toISOString(),
      finishedAt: new Date(3000).toISOString(),
    });
    expect(evidence.completed(11)).toBe(true);
    watch.dispose();
    await Promise.resolve();
    expect(evidence.completed(11)).toBe(false);
    expect(state.calls.some((c) => c.name === "anbo_unwatch_codex_turn")).toBe(
      true,
    );
  });
  it("ignores late channels from a removed/rebound leaf", () => {
    const watch = new CodexTurnWatch();
    watch.sync(tabs);
    watch.stop(11);
    watch.sync(tabs);
    state.channels[0].onmessage({
      startedAt: new Date(2000).toISOString(),
      finishedAt: new Date(3000).toISOString(),
    });
    expect(evidence.completed(11)).toBe(false);
    watch.sync([]);
  });
});
