import { afterEach, describe, expect, it } from "vitest";
import { codexTurnEvidence as evidence } from "./codexTurnEvidence";
import { classifyAgentScreen } from "./agentScreenClassifier";
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
    expect(classifyAgentScreen("codex", screen)).toBe("working");
    expect(classifyAgentScreen("codex", screen, true)).toBe("ready");
    expect(
      classifyAgentScreen("codex", `${screen}\nesc to interrupt`, true),
    ).toBe("working");
    expect(
      classifyAgentScreen("codex", "OpenAI Codex\nrequires approval", true),
    ).toBe("attention");
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
    observer.start(11, 2, "codex");
    evidence.start(11, 0);
    observer.input(11, "\r", 1000);
    observer.poll(() => screen, 1500);
    observer.poll(() => screen, 1700);
    expect(isAgentTuiReady("codex", screen, 11)).toBe(false);
    evidence.receive(11, complete(1100, 2000));
    observer.poll(() => screen, 2500);
    expect(observer.poll(() => screen, 2700)[0]?.kind).toBe("finished");
    expect(observer.poll(() => screen, 3000)).toEqual([]);
    expect(isAgentTuiReady("codex", screen, 11)).toBe(true);
  });
});
