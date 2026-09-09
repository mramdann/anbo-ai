import { describe, expect, it, vi } from "vitest";
import {
  classifyAgentScreen,
  classifyAgentTurn,
} from "./agentScreenClassifier";
import { BrowserTurnObserver } from "./browserTurnObserver";

const ready = ">\n? for shortcuts Gemini 3.8 Flash high 1 task(s) /tasks";
const background =
  "Antigravity CLI\nFinal answer\n>\n[19:58:24] python -m http.server 8089 running\n? for shortcuts Gemini 3.8 Flash high 1 task(s) /tasks";
const working =
  "Antigravity CLI\nWorking...\n>\nesc to cancel 1 task(s) /tasks";
const event = (
  sequence: number,
  phase = "done",
  ptyId: number | undefined = 1,
  tabId = 10,
  requestId = 1,
) => ({
  tabId,
  ptyId,
  sequence,
  phase,
  requestId,
  controlId: 1,
  method: "screenshot",
  actor: { brand: "antigravity", label: "Antigravity" },
});

describe("browser turn cleanup", () => {
  it("keeps Codex ownership between commentary and its next browser tool", () => {
    const observer = new BrowserTurnObserver();
    const gap = "OpenAI Codex\n\u2022 Next I will check the player.\n\u203a ";
    observer.start(1, 1, "codex");
    observer.receive(event(1), 0);
    observer.poll(() => gap, 200);
    expect(observer.poll(() => gap, 1_200)).toEqual([]);
    expect(observer.poll(() => gap, 30_000)).toEqual([]);
    observer.receive(event(2, "running", 1, 10, 2), 31_000);
    observer.receive(event(3, "done", 1, 10, 2), 32_000);
    const complete = `${gap}\n\u2500 Worked for 33s \u2500\u2500`;
    observer.poll(() => complete, 33_100);
    expect(observer.poll(() => complete, 33_300)).toEqual([
      { ptyId: 1, tabId: 10, controlId: 1, sequence: 3 },
    ]);
    expect(observer.poll(() => complete, 34_000)).toEqual([]);
  });

  it("ends Claude's owned surface after structural completion, not report words", () => {
    const observer = new BrowserTurnObserver();
    const complete = [
      "Claude Code",
      "Thought for 9s",
      "    loading/pendingUrl/committed URL terbedakan jelas.",
      "\u273b Saut\u00e9ed for 13m 12s \u00b7 done 8:03 PM",
      "\u276f ",
    ].join("\n");
    observer.start(1, 1, "claude");
    observer.receive(event(2), 0);
    expect(observer.poll(() => complete, 200)).toEqual([]);
    expect(observer.poll(() => complete, 800)).toEqual([]);
    expect(observer.poll(() => complete, 1_200)).toEqual([
      { ptyId: 1, tabId: 10, controlId: 1, sequence: 2 },
    ]);
    expect(observer.poll(() => complete, 1_400)).toEqual([]);
    observer.receive(event(3, "running", 1, 10, 2), 2_000);
    observer.poll(() => complete, 3_000);
    expect(observer.poll(() => complete, 3_200)).toEqual([]);
    observer.receive(event(4, "done", 1, 10, 2), 4_000);
    observer.poll(() => `${complete}\nesctointerrupt`, 5_000);
    expect(observer.poll(() => `${complete}\nesctointerrupt`, 5_200)).toEqual(
      [],
    );
  });

  it("separates a completed model turn from its background server", () => {
    expect(classifyAgentScreen("antigravity", background)).toBe("working");
    expect(classifyAgentTurn("antigravity", background)).toBe("ready");
    expect(classifyAgentTurn("agy", working)).toBe("working");
    expect(
      classifyAgentTurn(
        "antigravity",
        `${working}\nFinal answer\n>\n? for shortcuts`,
      ),
    ).toBe("ready");
    expect(
      classifyAgentTurn(
        "antigravity",
        "Requires approval\npress enter to confirm",
      ),
    ).toBe("attention");
  });

  it("ends all completed surfaces for the exact PTY after stable readiness", () => {
    const observer = new BrowserTurnObserver();
    observer.start(1, 1, "antigravity");
    observer.start(2, 2, "antigravity");
    observer.receive(event(2), 0);
    observer.receive(event(3, "error", 1, 11), 0);
    observer.receive(event(4, "done", 2, 12), 0);
    expect(observer.poll(() => background, 200)).toEqual([]);
    expect(observer.poll(() => background, 800)).toEqual([]);
    expect(
      observer.poll((leaf) => (leaf === 1 ? background : working), 1200),
    ).toEqual([
      { ptyId: 1, tabId: 10, controlId: 1, sequence: 2 },
      { ptyId: 1, tabId: 11, controlId: 1, sequence: 3 },
    ]);
    expect(observer.poll(() => background, 1400)).toEqual([]);
  });

  it("retains the cursor through long thinking and permission waits", () => {
    const observer = new BrowserTurnObserver();
    observer.start(1, 1, "antigravity");
    observer.receive(event(2), 0);
    for (const screen of [
      working,
      "Requires approval\npress enter to confirm",
    ]) {
      for (const now of [1000, 1200, 60_000, 600_000])
        expect(observer.poll(() => screen, now)).toEqual([]);
    }
  });

  it("does not finish in-flight work, and rechecks the prompt after completion", () => {
    const observer = new BrowserTurnObserver();
    observer.start(1, 1, "antigravity");
    observer.receive(event(2, "running"), 0);
    observer.poll(() => ready, 1000);
    expect(observer.poll(() => ready, 1200)).toEqual([]);
    observer.receive(event(3), 2000);
    expect(observer.poll(() => ready, 2200)).toEqual([]);
    expect(observer.poll(() => ready, 2400)).toEqual([]);
    expect(observer.poll(() => ready, 3200)).toHaveLength(1);
  });

  it("new input and newer browser work invalidate previous readiness", () => {
    const observer = new BrowserTurnObserver();
    observer.start(1, 1, "antigravity");
    observer.receive(event(2), 0);
    observer.poll(() => ready, 1000);
    observer.input(1, "\r", 1100);
    expect(observer.poll(() => ready, 1200)).toEqual([]);
    observer.receive(event(4, "running", 1, 10, 3), 1300);
    observer.receive(event(5, "done", 1, 10, 1), 1400); // stale completion
    expect(observer.poll(() => ready, 2600)).toEqual([]);
    expect(observer.poll(() => ready, 2800)).toEqual([]);
    observer.receive(event(6, "done", 1, 10, 3), 3000);
    observer.poll(() => ready, 4000);
    expect(observer.poll(() => ready, 4200)).toEqual([
      { ptyId: 1, tabId: 10, controlId: 1, sequence: 6 },
    ]);
  });

  it("unbound callers, ownership handoffs, ended sessions and stopped leaves do not leak", () => {
    const observer = new BrowserTurnObserver();
    observer.start(1, 1, "antigravity");
    const read = vi.fn(() => ready);
    observer.poll(read, 0);
    expect(read).not.toHaveBeenCalled();
    observer.receive({ ...event(2), ptyId: undefined }, 0);
    observer.poll(read, 2000);
    expect(read).not.toHaveBeenCalled();
    observer.receive(event(3), 0);
    observer.receive({ ...event(4, "running", 2, 10, 4), controlId: 4 }, 50);
    observer.receive({ ...event(5, "done", 2, 10, 4), controlId: 4 }, 100);
    observer.poll(read, 2000);
    expect(read).not.toHaveBeenCalled();
    observer.receive(event(6, "done", 1, 10, 5), 0);
    observer.receive(event(7, "ended", 1, 10, 5), 100);
    observer.poll(read, 2000);
    expect(read).not.toHaveBeenCalled();
    observer.receive(event(8, "done", 1, 10, 7), 0);
    observer.stop(1);
    observer.poll(read, 2000);
    expect(read).not.toHaveBeenCalled();
  });
});
