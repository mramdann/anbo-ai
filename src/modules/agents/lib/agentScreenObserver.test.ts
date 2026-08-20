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
    expect(observer.poll(() => ready, 1_200)[0]?.kind).toBe("finished");
  });
});
