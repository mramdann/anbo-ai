import { describe, expect, it } from "vitest";
import {
  AGENT_BROWSER_WORKING_MS,
  AgentScreenObserver,
} from "./agentScreenObserver";

const ready = "OpenAI Codex\n› Ask Codex to do anything\ngpt-5.6-sol high";

describe("AgentScreenObserver", () => {
  it("finishes Claude once after report prose and an accented completion", () => {
    const observer = new AgentScreenObserver();
    const idle = "Claude Code\n\u276f \n? for shortcuts";
    const active = `${idle}\nThought for 9s\nesctointerrupt`;
    const complete = [
      "Claude Code",
      "Thought for 9s",
      "    loading/pendingUrl/committed URL terbedakan jelas.",
      "\u273b Saut\u00e9ed for 13m 12s \u00b7 done 8:03 PM",
      "\u276f ",
      "bypass permissions on (shift+tab to cycle)",
    ].join("\n");
    observer.start(10, 20, "claude");
    observer.poll(() => idle, 0);
    observer.poll(() => idle, 200);
    observer.input(10, "\r", 300);
    observer.poll(() => active, 500);
    observer.poll(() => active, 700);
    expect(observer.poll(() => complete, 1_500)).toEqual([]);
    expect(observer.poll(() => complete, 1_700)).toEqual([
      expect.objectContaining({ kind: "finished", leafId: 10, ptyId: 20 }),
    ]);
    expect(observer.poll(() => complete, 60_000)).toEqual([]);
    observer.input(10, "\r", 60_100);
    observer.poll(() => `${complete}\nesctointerrupt`, 61_200);
    expect(observer.poll(() => `${complete}\nesctointerrupt`, 61_400)).toEqual(
      [],
    );
  });

  it("settles startup without reporting a completed turn", () => {
    const observer = new AgentScreenObserver();
    expect(observer.start(10, 20, "codex").kind).toBe("working");
    expect(observer.poll(() => ready, 0)).toEqual([]);
    expect(observer.poll(() => ready, 100)).toEqual([
      expect.objectContaining({ kind: "ready", leafId: 10, ptyId: 20 }),
    ]);
  });

  it("tracks submit, permission attention, and completion without hooks", () => {
    const observer = new AgentScreenObserver();
    observer.start(10, 20, "codex");
    observer.poll(() => ready, 0);
    observer.poll(() => ready, 100);

    expect(observer.input(10, "\r", 200)?.kind).toBe("working");
    const approval =
      "This command requires approval\n1. Yes\nPress enter to confirm";
    expect(observer.poll(() => approval, 300)).toEqual([]);
    expect(observer.poll(() => approval, 400)[0]?.kind).toBe("attention");
    expect(observer.input(10, "\r", 500)?.kind).toBe("working");
    observer.poll(() => ready, 1_600);
    expect(observer.poll(() => ready, 1_700)[0]?.kind).toBe("finished");
  });

  it("does not finish while the minimum working window is active", () => {
    const observer = new AgentScreenObserver();
    observer.start(10, 20, "codex");
    observer.poll(() => ready, 0);
    observer.poll(() => ready, 100);
    observer.input(10, "\r", 200);
    observer.poll(() => ready, 300);
    expect(observer.poll(() => ready, 400)).toEqual([]);
    expect(observer.poll(() => ready, 1_200)).toEqual([]);
    expect(observer.poll(() => ready, 2_600)).toEqual([]);
    expect(observer.poll(() => ready, 2_700)[0]?.kind).toBe("finished");
  });

  it("gives Antigravity time to start before treating its mounted prompt as finished", () => {
    const observer = new AgentScreenObserver();
    const antigravityReady =
      "Antigravity CLI\n>\n? for shortcuts\nGemini 3.7 Flash · high";
    observer.start(10, 20, "antigravity");
    observer.poll(() => antigravityReady, 0);
    observer.poll(() => antigravityReady, 100);
    observer.input(10, "\r", 200);

    observer.poll(() => antigravityReady, 300);
    expect(observer.poll(() => antigravityReady, 400)).toEqual([]);
    expect(observer.poll(() => antigravityReady, 1_300)).toEqual([]);
    expect(observer.poll(() => antigravityReady, 11_200)).toEqual([]);
    expect(observer.poll(() => antigravityReady, 11_300)[0]?.kind).toBe(
      "finished",
    );
  });

  it("does not let a persistent ready prompt overwrite a new working turn", () => {
    const observer = new AgentScreenObserver();
    observer.start(10, 20, "codex");
    observer.poll(() => ready, 0);
    observer.poll(() => ready, 100);

    expect(observer.input(10, "\r", 200)?.kind).toBe("working");
    expect(observer.poll(() => ready, 1_200)).toEqual([]);
    expect(observer.poll(() => ready, 1_400)).toEqual([]);

    const active =
      "OpenAI Codex\n• Working (3s · esc to interrupt)\n› \ngpt-5.6-sol high";
    expect(observer.poll(() => active, 1_600)).toEqual([]);
    expect(observer.poll(() => active, 1_800)).toEqual([]);

    expect(observer.poll(() => ready, 2_000)).toEqual([]);
    expect(observer.poll(() => ready, 2_200)[0]?.kind).toBe("finished");
  });

  it("does not emit repeated Claude finishes while thought progress is live", () => {
    const observer = new AgentScreenObserver();
    const claudeReady =
      "Claude Code\n\u276f \nmanual mode on Â· ? for shortcuts";
    observer.start(10, 20, "claude");
    observer.poll(() => claudeReady, 0);
    observer.poll(() => claudeReady, 100);
    observer.input(10, "\r", 200);

    const active = [
      "Claude Code",
      "\u276f previous request",
      "answer",
      "Brewed for 4s",
      "\u276f long running request",
      "Thought for 6s",
      "Web Search(latest information)",
      "Thought for 9s",
      "\u276f ",
      "manual mode on Â· ? for shortcuts",
    ].join("\n");
    expect(observer.poll(() => active, 1_400)).toEqual([]);
    expect(observer.poll(() => active, 1_600)).toEqual([]);
    expect(observer.poll(() => active, 4_000)).toEqual([]);
    expect(observer.poll(() => active, 6_000)).toEqual([]);

    const settled = `${active}\nfinal answer\nBrewed for 10s`;
    expect(observer.poll(() => settled, 6_200)).toEqual([]);
    expect(observer.poll(() => settled, 6_400)[0]?.kind).toBe("finished");

    // Repainting the same completed turn as active and settled again must not
    // retain another finished notification without new terminal input.
    expect(observer.poll(() => active, 6_600)).toEqual([]);
    expect(observer.poll(() => active, 6_800)[0]?.kind).toBe("working");
    expect(observer.poll(() => settled, 7_000)).toEqual([]);
    expect(observer.poll(() => settled, 7_200)[0]?.kind).toBe("ready");
    expect(observer.poll(() => settled, 8_800)).toEqual([]);
  });

  it("restores an idle Claude screen after a multi-minute Churned turn", () => {
    const observer = new AgentScreenObserver();
    const restored = [
      "Claude Code v2.1.247",
      "\u276f inspect this workspace",
      "Thought for 6s",
      "final answer",
      "Churned for 1m 37s · done 1:01 PM",
      "\u276f ",
      "manual mode on · ? for shortcuts",
    ].join("\n");

    expect(observer.start(10, 20, "claude").kind).toBe("working");
    expect(observer.poll(() => restored, 0)).toEqual([]);
    expect(observer.poll(() => restored, 100)).toEqual([
      expect.objectContaining({ kind: "ready", leafId: 10, ptyId: 20 }),
    ]);
  });
});

describe("browser work as evidence", () => {
  it("reports the agent working from a served tool call, not just the screen", () => {
    // Kimi keeps its composer mounted through a turn, so a screen read between
    // two MCP calls looks settled. Anbo served those calls and is drawing a
    // cursor for them on the tab, so it already knows better.
    const idle = [
      "Welcome to Kimi Code!",
      "  > ",
      "Never Ask  GLM-5.3  D:work   context: 4% (33k/977k)",
    ].join("\n");
    const observer = new AgentScreenObserver();
    observer.start(7, 70, "kimi");
    observer.poll(() => idle, 0);
    expect(observer.poll(() => idle, 200)).toEqual([
      { leafId: 7, ptyId: 70, agent: "kimi", kind: "ready" },
    ]);

    // A tool call lands while the screen still shows a settled composer.
    expect(observer.activity(7, 1_000)).toEqual({
      leafId: 7,
      ptyId: 70,
      agent: "kimi",
      kind: "working",
    });
    // And the settled screen must not talk it back out of working while the
    // call is in flight.
    expect(observer.poll(() => idle, 1_200)).toEqual([]);
    expect(observer.poll(() => idle, 1_400)).toEqual([]);
  });

  it("does not announce a finish in the gap between two tool calls", () => {
    // A model pauses for seconds between calls and some CLIs paint nothing in
    // that gap. Announcing "finished" there fires a notification mid-turn and
    // then has to take it back on the next call.
    const idle = ["  > ", "Never Ask  GLM-5.3  context: 4%"].join("\n");
    const observer = new AgentScreenObserver();
    observer.start(9, 90, "kimi");
    observer.activity(9, 0, AGENT_BROWSER_WORKING_MS);
    for (const now of [1_500, 2_000, 3_000, 4_000, 5_000]) {
      expect(observer.poll(() => idle, now)).toEqual([]);
    }
    // The next call arrives and the hold simply extends.
    observer.activity(9, 5_500, AGENT_BROWSER_WORKING_MS);
    expect(observer.poll(() => idle, 8_000)).toEqual([]);
  });

  it("still finishes the turn once the calls stop and the screen settles", () => {
    const idle = ["  > ", "Never Ask  GLM-5.3  context: 4%"].join("\n");
    const observer = new AgentScreenObserver();
    observer.start(8, 80, "kimi");
    observer.activity(8, 0, AGENT_BROWSER_WORKING_MS);
    observer.poll(() => idle, 100);
    const settled = observer.poll(() => idle, 7_000);
    expect(settled).toEqual([
      { leafId: 8, ptyId: 80, agent: "kimi", kind: "finished" },
    ]);
  });
});
