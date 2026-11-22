import { beforeEach, describe, expect, it } from "vitest";
import { resumePendingFor, useResumeGate } from "./resumeGateStore";

beforeEach(() => {
  useResumeGate.setState({ pending: new Set() });
});

describe("useResumeGate", () => {
  it("holds the workspaces that wait until each is released", () => {
    const { ask, release } = useResumeGate.getState();
    ask(["a", "b"]);
    expect([...useResumeGate.getState().pending]).toEqual(["a", "b"]);
    release("a");
    expect([...useResumeGate.getState().pending]).toEqual(["b"]);
    ask(["a"]);
    expect([...useResumeGate.getState().pending]).toEqual(["b", "a"]);
  });

  it("keeps the same set when nothing changes, so nothing re-renders", () => {
    const { ask, release } = useResumeGate.getState();
    ask(["a"]);
    const before = useResumeGate.getState().pending;
    ask(["a"]);
    release("never-asked");
    ask([]);
    expect(useResumeGate.getState().pending).toBe(before);
  });
});

describe("resumePendingFor", () => {
  it("is the waiting workspaces while the question is on", () => {
    const pending = new Set(["a"]);
    expect(resumePendingFor(pending, true)).toBe(pending);
  });

  it("is nobody, and always the same nobody, while the question is off", () => {
    const off = resumePendingFor(new Set(["a"]), false);
    expect(off.size).toBe(0);
    expect(resumePendingFor(new Set(["b"]), false)).toBe(off);
  });
});
