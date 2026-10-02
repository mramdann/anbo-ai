import { describe, expect, it } from "vitest";
import { agentScreens as screens } from "./agentScreen.fixtures";
import type { TurnEvidence } from "./agentScreenClassifier";
import {
  AgentScreenObserver,
  type ObservedAgentSignal,
} from "./agentScreenObserver";

type Screen = keyof typeof screens;
type Timed = ObservedAgentSignal & { at: number };

const screen = (name: Screen) => screens[name].join("\n");

/** Polls every 200 ms over [from, to], as the bridge does. */
function run(
  observer: AgentScreenObserver,
  read: string | null | ((now: number) => string | null),
  from: number,
  to: number,
): Timed[] {
  const out: Timed[] = [];
  for (let now = from; now <= to; now += 200) {
    const text = typeof read === "function" ? read(now) : read;
    for (const signal of observer.poll(() => text, now)) {
      out.push({ ...signal, at: now });
    }
  }
  return out;
}

const kinds = (signals: readonly { kind: string }[]) =>
  signals.map((signal) => signal.kind);

function settled(agent: string, idle: Screen): AgentScreenObserver {
  const observer = new AgentScreenObserver();
  observer.start(1, 7, agent, 0);
  expect(kinds(run(observer, screen(idle), 200, 1_000))).toEqual(["ready"]);
  return observer;
}

describe("turns", () => {
  it("settles startup without announcing a turn", () => {
    const observer = new AgentScreenObserver();
    expect(observer.start(1, 7, "claude", 0).kind).toBe("working");
    expect(kinds(run(observer, screen("claudeIdleAuto"), 200, 5_000))).toEqual([
      "ready",
    ]);
  });

  it("settles an Antigravity sign-in at launch without announcing a turn", () => {
    // In prod a background agy that had to sign in again was announced as
    // "finished · 3s" before anyone had asked it anything.
    const observer = new AgentScreenObserver();
    observer.start(1, 7, "antigravity", 0);
    const frames = ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"];
    const signingIn = (now: number) =>
      screen("agySigningIn").replace(
        "⣾",
        frames[Math.floor(now / 100) % frames.length],
      );
    expect(run(observer, signingIn, 200, 3_000)).toEqual([]);
    expect(kinds(run(observer, screen("agyIdle"), 3_200, 10_000))).toEqual([
      "ready",
    ]);
  });

  it("announces a submitted turn once, with how long it took", () => {
    const observer = settled("claude", "claudeIdleAuto");
    expect(observer.input(1, "Jawab satu kata saja", 2_000)).toBeNull();
    expect(observer.input(1, "\r", 2_000)?.kind).toBe("working");
    expect(run(observer, screen("claudeThinking"), 2_200, 6_000)).toEqual([]);
    const done = run(observer, screen("claudeFinishedShort"), 6_200, 12_000);
    expect(kinds(done)).toEqual(["finished"]);
    expect(done[0].durationMs).toBe(4_200);
    expect(done[0].at).toBeGreaterThanOrEqual(7_200);
  });

  it("starts no turn for a slash command, an empty Enter or a menu key", () => {
    const observer = settled("claude", "claudeIdleAuto");
    expect(observer.input(1, "/clear\r", 2_000)).toBeNull();
    expect(observer.input(1, "\r", 2_200)).toBeNull();
    expect(observer.input(1, "\u001b[B", 2_400)).toBeNull();
    expect(run(observer, screen("claudeCleared"), 2_600, 15_000)).toEqual([]);
  });

  it("lets an Enter that never became work go back to waiting quietly", () => {
    // Kimi folds an Enter that arrives too soon into its box as a newline.
    const observer = settled("kimi", "kimiIdle");
    expect(observer.input(1, "halo\r", 2_000)?.kind).toBe("working");
    const signals = run(observer, screen("kimiIdle"), 2_200, 12_000);
    expect(kinds(signals)).toEqual(["ready"]);
    expect(signals[0].at).toBeGreaterThanOrEqual(8_000);
  });

  it("keeps a prompt the agent blocks on inside the turn that asked it", () => {
    const observer = settled("claude", "claudeIdleAuto");
    observer.input(1, "Buat file catatan.txt\r", 2_000);
    expect(
      kinds(run(observer, screen("claudeCreateDialog"), 2_200, 4_000)),
    ).toEqual(["attention"]);
    // Claude takes the option's number without Enter.
    expect(observer.input(1, "1", 4_100)).toBeNull();
    expect(
      kinds(run(observer, screen("claudeToolRunning"), 4_200, 6_000)),
    ).toEqual(["working"]);
    const done = run(observer, screen("claudeFinishedShort"), 6_200, 9_000);
    expect(kinds(done)).toEqual(["finished"]);
    expect(done[0].durationMs).toBe(4_200);
  });

  it("moves an answered prompt back to work at once on Enter", () => {
    const observer = settled("claude", "claudeIdleAuto");
    observer.input(1, "tanya saya\r", 2_000);
    run(observer, screen("claudeQuestion"), 2_200, 3_000);
    expect(observer.input(1, "\r", 3_100)?.kind).toBe("working");
  });

  it("does not make a turn of a prompt answered at startup", () => {
    const observer = new AgentScreenObserver();
    observer.start(1, 7, "claude", 0);
    expect(kinds(run(observer, screen("claudeTrust"), 200, 1_000))).toEqual([
      "attention",
    ]);
    expect(observer.input(1, "\u001b[B", 1_100)).toBeNull();
    expect(observer.input(1, "\r", 1_200)).toBeNull();
    expect(
      kinds(run(observer, screen("claudeIdleAuto"), 1_400, 5_000)),
    ).toEqual(["ready"]);
  });

  it("announces work that started by itself, like a finished background task", () => {
    const observer = settled("claude", "claudeIdleBypass");
    const working = run(observer, screen("claudeThinking"), 2_000, 4_000);
    expect(kinds(working)).toEqual(["working"]);
    expect(working[0].turnStartedAt).toBe(2_000);
    const done = run(observer, screen("claudeFinishedShort"), 4_200, 7_000);
    expect(kinds(done)).toEqual(["finished"]);
  });

  it("names the work left running when a turn ends, and when it stops", () => {
    const observer = settled("claude", "claudeIdleBypass");
    observer.input(1, "jalankan di background\r", 2_000);
    run(observer, screen("claudeThinking"), 2_200, 3_000);
    const done = run(observer, screen("claudeBackgroundShell"), 3_200, 6_000);
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ kind: "finished", background: "1 shell" });
    const cleared = run(observer, screen("claudeFinishedShort"), 6_200, 7_000);
    expect(cleared).toHaveLength(1);
    expect(cleared[0]).toMatchObject({ kind: "ready", background: null });
  });
});

describe("pauses inside a turn", () => {
  it("holds Antigravity through the pause between a command and the model", () => {
    const observer = settled("antigravity", "agyIdle");
    observer.input(1, "jalankan perintah\r", 2_000);
    run(observer, screen("agyGenerating"), 2_200, 4_000);
    // Measured at 2.5 s in the capture.
    expect(run(observer, screen("agyCommandGap"), 4_200, 6_800)).toEqual([]);
    expect(run(observer, screen("agyGenerating"), 7_000, 8_000)).toEqual([]);
    const done = run(observer, screen("agyIdle"), 8_200, 13_000);
    expect(kinds(done)).toEqual(["finished"]);
    expect(done[0].at).toBeGreaterThanOrEqual(11_700);
  });

  it("does not end a turn while text is still arriving with no progress row", () => {
    const observer = settled("kimi", "kimiIdle");
    observer.input(1, "tulis panjang\r", 2_000);
    run(observer, screen("kimiSpinner"), 2_200, 3_000);
    const streaming = (now: number) =>
      [`  paragraf ${Math.floor(now / 200)}`, ...screens.kimiIdle].join("\n");
    expect(run(observer, streaming, 3_200, 8_000)).toEqual([]);
    const done = run(observer, screen("kimiIdle"), 8_200, 11_000);
    expect(kinds(done)).toEqual(["finished"]);
    expect(done[0].at).toBeGreaterThanOrEqual(9_700);
  });

  it("waits out Codex commentary that has no turn-end row yet", () => {
    const observer = settled("codex", "codexIdle");
    observer.input(1, "jalankan\r", 2_000);
    run(observer, screen("codexWorking"), 2_200, 3_000);
    expect(run(observer, screen("codexCommentary"), 3_200, 25_000)).toEqual([]);
    const done = run(observer, screen("codexFinishedShort"), 25_200, 29_000);
    expect(kinds(done)).toEqual(["finished"]);
    expect(done[0].at).toBeGreaterThanOrEqual(27_700);
  });

  it("ends a Codex turn at once when its rollout records it finished", () => {
    let evidence: TurnEvidence = "running";
    const observer = new AgentScreenObserver({ evidence: () => evidence });
    observer.start(1, 7, "codex", 0);
    run(observer, screen("codexIdle"), 200, 1_000);
    observer.input(1, "jalankan\r", 2_000);
    expect(run(observer, screen("codexCommentary"), 2_200, 10_000)).toEqual([]);
    evidence = "complete";
    const done = run(observer, screen("codexCommentary"), 10_200, 11_000);
    expect(kinds(done)).toEqual(["finished"]);
    expect(done[0].at).toBe(10_400);
  });

  it("treats a tool call Anbo served as work until the calls stop", () => {
    const observer = settled("claude", "claudeIdleBypass");
    expect(observer.activity(1, 2_000, 6_000)?.kind).toBe("working");
    expect(run(observer, screen("claudeIdleBypass"), 2_200, 7_800)).toEqual([]);
    expect(observer.activity(1, 7_900, 6_000)).toBeNull();
    const done = run(observer, screen("claudeIdleBypass"), 8_000, 16_000);
    expect(kinds(done)).toEqual(["finished"]);
    expect(done[0].at).toBeGreaterThanOrEqual(13_900);
  });
});

describe("screens that say nothing", () => {
  it("reads no buffer as no news", () => {
    const observer = new AgentScreenObserver();
    observer.start(1, 7, "claude", 0);
    expect(run(observer, null, 200, 30_000)).toEqual([]);
  });

  it("lets an unrecognised, motionless screen settle to waiting", () => {
    const observer = new AgentScreenObserver();
    observer.start(1, 7, "claude", 0);
    const signals = run(observer, "PS D:\\work> claude --version", 200, 12_000);
    expect(kinds(signals)).toEqual(["ready"]);
    expect(signals[0].at).toBeGreaterThanOrEqual(10_000);
  });

  it("keeps the last phase when asked not to guess", () => {
    const observer = new AgentScreenObserver({ settleUnknownMs: null });
    observer.start(1, 7, "claude", 0);
    expect(run(observer, "PS D:\\work>", 200, 30_000)).toEqual([]);
  });
});

describe("what counts as a submitted message", () => {
  it.each([
    [
      "a paste followed by Enter",
      ["\u001b[200~dua baris\nteks\u001b[201~", "\r"],
      true,
    ],
    ["text cleared with ctrl+u", ["halo", "\u0015", "\r"], false],
    ["text erased with backspace", ["hi", "\u007f\u007f", "\r"], false],
    ["text abandoned with Esc", ["halo", "\u001b", "\r"], false],
    ["arrow keys only", ["\u001b[A", "\u001b[B", "\r"], false],
    ["a slash command with arguments", ["/model sonnet", "\r"], false],
  ])("%s", (_name, chunks, starts) => {
    const observer = settled("claude", "claudeIdleAuto");
    const signals = (chunks as string[])
      .map((chunk, index) => observer.input(1, chunk, 2_000 + index))
      .filter(Boolean);
    expect(signals.length > 0).toBe(starts);
  });
});
