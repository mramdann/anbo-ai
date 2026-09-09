import { Channel, invoke } from "@tauri-apps/api/core";
import type { Tab } from "@/modules/tabs";
import { ptyIdForLeaf } from "@/modules/terminal";
import { useAgentStore } from "../store/agentStore";
import { codexTurnEvidence } from "./codexTurnEvidence";
import { collectAgentResumeLeaves } from "./resume";

export class CodexTurnWatch {
  private readonly entries = new Map<
    number,
    { identity: string; key: string }
  >();
  sync(tabs: Tab[]) {
    const retained = new Set<number>();
    for (const tab of tabs) {
      if (tab.kind !== "terminal" || tab.private) continue;
      for (const leaf of collectAgentResumeLeaves(tab.paneTree)) {
        const session = useAgentStore.getState().sessions[leaf.id];
        const ptyId = ptyIdForLeaf(leaf.id);
        const cwd = leaf.cwd ?? tab.cwd;
        if (
          session?.agent !== "codex" ||
          !leaf.resume.sessionId ||
          !cwd ||
          ptyId === null
        )
          continue;
        retained.add(leaf.id);
        const identity = `${ptyId}:${session.startedAt}:${leaf.resume.sessionId}:${cwd}`;
        if (this.entries.get(leaf.id)?.identity === identity) continue;
        if (this.entries.has(leaf.id)) this.stop(leaf.id);
        const key = crypto.randomUUID();
        this.entries.set(leaf.id, { identity, key });
        codexTurnEvidence.start(leaf.id, session.startedAt);
        const channel = new Channel<unknown>();
        channel.onmessage = (value) => {
          if (this.entries.get(leaf.id)?.key === key)
            codexTurnEvidence.receive(leaf.id, value);
        };
        void invoke("anbo_watch_codex_turn", {
          key,
          ptyId,
          cwd,
          sessionId: leaf.resume.sessionId,
          onChange: channel,
        })
          .then(() => {
            if (this.entries.get(leaf.id)?.key !== key)
              void invoke("anbo_unwatch_codex_turn", { key }).catch(() => {});
          })
          .catch(() => {
            if (this.entries.get(leaf.id)?.key === key)
              codexTurnEvidence.receive(leaf.id, null);
          });
      }
    }
    for (const leaf of this.entries.keys())
      if (!retained.has(leaf)) this.stop(leaf);
  }
  stop(leaf: number) {
    const entry = this.entries.get(leaf);
    this.entries.delete(leaf);
    codexTurnEvidence.stop(leaf);
    if (entry)
      void invoke("anbo_unwatch_codex_turn", { key: entry.key }).catch(
        () => {},
      );
  }
  dispose() {
    for (const leaf of this.entries.keys()) this.stop(leaf);
  }
}
