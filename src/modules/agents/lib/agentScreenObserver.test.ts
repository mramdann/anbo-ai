import { describe, expect, it } from "vitest";
import { AgentScreenObserver } from "./agentScreenObserver";

const ready = "OpenAI Codex\n› Ask Codex to do anything\ngpt-5.6-sol high";

describe("AgentScreenObserver", () => {
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
    expect(observer.poll(() => settled, 7_200)).toEqual([]);
    expect(observer.poll(() => settled, 8_800)[0]?.kind).toBe("ready");
  });
});
