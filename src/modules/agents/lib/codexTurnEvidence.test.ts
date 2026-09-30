import { afterEach, describe, expect, it } from "vitest";
import { codexTurnEvidence as evidence } from "./codexTurnEvidence";
import { classifyAgentScreen, readAgentScreen } from "./agentScreenClassifier";
import { AgentScreenObserver } from "./agentScreenObserver";
import { isAgentTuiReady } from "./agentAutomation";

const screen = "OpenAI Codex\n\u2022 Final answer\n\u203a \ngpt-6-astra";
const stamp = (ms: number) => new Date(ms).toISOString();
const complete = (start: number, end: number) => ({
  startedAt: stamp(start),
  finishedAt: stamp(end),
});
afterEach(() => {
  evidence.stop(11);
  evidence.stop(12);
});
describe("exact Codex turn evidence", () => {
  it("retries discovery on submitted input and retains its cutoff through late binding", () => {
    expect(evidence.input(11, "typing", false, 1000)).toBe(false);
    expect(evidence.input(11, "\r", false, 4000)).toBe(true);
    evidence.start(11, 1000);
    evidence.receive(11, complete(2000, 5000));
    expect(evidence.completed(11)).toBe(false);
    evidence.receive(11, complete(4100, 5000));
    expect(evidence.completed(11)).toBe(true);
    expect(evidence.input(11, "\r", false, 6000)).toBe(false);
    expect(evidence.completed(11)).toBe(false);
  });
  it("does not treat a commentary gap as completion", () => {
    // Commentary with no turn-end row looks idle but unfinished: not work on
    // its own, and not a prompt to type into.
    expect(readAgentScreen("codex", screen)).toMatchObject({
      state: "ready",
      settling: true,
    });
    expect(isAgentTuiReady("codex", screen)).toBe(false);
    expect(readAgentScreen("codex", screen, "complete")).toMatchObject({
      state: "ready",
      settling: false,
    });
    expect(classifyAgentScreen("codex", screen, "running")).toBe("working");
    expect(
      classifyAgentScreen(
        "codex",
        `${screen}\n• Working (3s • esc to interrupt)`,
        "complete",
      ),
    ).toBe("working");
  });
  it("ignores old turns, new input, failed reads and another leaf", () => {
    evidence.start(11, 1000);
    evidence.receive(11, complete(100, 900));
    expect(evidence.completed(11)).toBe(false);
    evidence.receive(11, complete(2000, 3000));
    expect(evidence.completed(11)).toBe(true);
    expect(evidence.completed(12)).toBe(false);
    evidence.input(11, "\r", false, 4000);
    evidence.receive(11, complete(2000, 4500));
    expect(evidence.completed(11)).toBe(false);
    evidence.receive(11, complete(4100, 5000));
    expect(evidence.completed(11)).toBe(true);
    evidence.receive(11, null);
    expect(evidence.completed(11)).toBe(false);
  });
  it("keeps approval input in the existing turn but invalidates an old completion", () => {
    evidence.start(11, 1000);
    evidence.receive(11, { startedAt: stamp(2000) });
    evidence.input(11, "\r", true, 2500);
    evidence.receive(11, complete(2000, 3000));
    expect(evidence.completed(11)).toBe(true);
  });
  it("settles once through the shared observer and permits the verified composer", () => {
    const observer = new AgentScreenObserver();
    observer.start(11, 2, "codex", 0);
    evidence.start(11, 0);
    evidence.input(11, "\r", false, 1000);
    observer.input(11, "next\r", 1000);
    observer.poll(() => screen, 1500);
    expect(observer.poll(() => screen, 1700)).toEqual([]);
    expect(isAgentTuiReady("codex", screen, 11)).toBe(false);
    evidence.receive(11, complete(1100, 2000));
    // The rollout closed the turn: no hold, no thirty-second settling wait.
    const signals = observer.poll(() => screen, 2500);
    expect(signals.map((signal) => signal.kind)).toEqual(["finished"]);
    expect(signals[0].durationMs).toBe(500);
    expect(observer.poll(() => screen, 3000)).toEqual([]);
    expect(isAgentTuiReady("codex", screen, 11)).toBe(true);
  });
});
