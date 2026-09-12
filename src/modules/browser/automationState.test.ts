import { describe, expect, it } from "vitest";
import {
  acceptsAutomationState,
  automationLabel,
  parseAutomationState,
} from "./automationState";

const event = {
  tabId: 7,
  requestId: 1,
  sequence: 1,
  method: "click",
  phase: "running",
  actor: { brand: "codex", label: "untrusted name" },
};
describe("browser automation identity", () => {
  it("uses canonical brand labels, not arbitrary text from the transport", () => {
    expect(parseAutomationState(event)?.actor).toEqual({
      brand: "codex",
      label: "Codex",
    });
    // The terminal is carried so this window can look the agent's callsign up
    // for itself. A name off the wire would be a free impersonation, so it is
    // still refused however it arrives.
    expect(
      parseAutomationState({
        ...event,
        actor: { brand: "codex", label: "Leander", ptyId: 4242 },
      })?.actor,
    ).toEqual({ brand: "codex", label: "Codex", ptyId: 4242 });
    for (const bad of [0, -3, 1.5, "4242", null]) {
      expect(
        parseAutomationState({
          ...event,
          actor: { brand: "codex", ptyId: bad },
        })?.actor,
      ).toEqual({ brand: "codex", label: "Codex" });
    }
    expect(
      parseAutomationState({ ...event, actor: { brand: "__proto__" } })?.actor,
    ).toEqual({ brand: "remote", label: "Remote agent" });
  });
  it.each([
    null,
    {},
    { ...event, tabId: -1 },
    { ...event, sequence: Infinity },
    { ...event, requestId: 0 },
    { ...event, method: "x".repeat(49) },
    { ...event, phase: "unknown" },
  ])("rejects invalid activity", (value) => {
    expect(parseAutomationState(value)).toBeNull();
  });
  it("ignores reordered messages and completion from a different request", () => {
    const current = parseAutomationState(event);
    if (!current) throw new Error("Valid fixture was rejected");
    expect(acceptsAutomationState(current, current)).toBe(false);
    expect(
      acceptsAutomationState(current, {
        ...current,
        requestId: 2,
        sequence: 2,
        phase: "done",
      }),
    ).toBe(false);
    expect(
      acceptsAutomationState(current, {
        ...current,
        requestId: 2,
        sequence: 2,
      }),
    ).toBe(true);
    expect(
      acceptsAutomationState(current, {
        ...current,
        sequence: 2,
        phase: "done",
      }),
    ).toBe(true);
  });
  it("describes phase without leaking arguments", () => {
    const current = parseAutomationState({
      ...event,
      text: "secret password",
    });
    if (!current) throw new Error("Valid fixture was rejected");
    expect(automationLabel(current)).toBe("Clicking");
    expect(automationLabel({ ...current, phase: "error" })).toBe(
      "Action stopped",
    );
    expect(JSON.stringify(current)).not.toContain("secret");
  });
});

// A parked tab: the sweep found the session silent, the tab is still held.
const parked = parseAutomationState({
  tabId: 4,
  requestId: 9,
  sequence: 12,
  method: "click",
  phase: "idle",
  controlId: 3,
  actor: { brand: "claude" },
});
it("names a parked tab as still held", () => {
  if (!parked) throw new Error("idle was rejected");
  expect(automationLabel(parked)).toBe("Idle, still holding this tab");
});
it("lets work resume on a parked tab", () => {
  if (!parked) throw new Error("idle was rejected");
  expect(
    acceptsAutomationState(parked, {
      ...parked,
      requestId: 10,
      sequence: 13,
      phase: "queued",
    }),
  ).toBe(true);
});
