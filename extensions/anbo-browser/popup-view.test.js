import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { failureView, popupView } from "./popup-view.js";

const base = { connected: false, approved: false, busy: false, error: "", name: "", label: "", selected: 0 };

describe("popup view", () => {
  it("offers to connect a profile that is not connected", () => {
    expect(popupView(base)).toEqual({
      tone: "idle",
      headline: "Not connected",
      detail: ["Start Anbo, then connect this profile."],
      connected: false,
    });
    expect(popupView({ ...base, error: "Anbo disconnected. Reconnect and approve this profile again." })).toMatchObject({
      tone: "bad",
      detail: ["Anbo disconnected. Reconnect and approve this profile again."],
      connected: false,
    });
    expect(popupView({ ...base, busy: true })).toMatchObject({ headline: "Disconnecting", connected: false });
  });

  it("names the profile Anbo waits to approve and keeps the label as text", () => {
    const label = "<img src=x onerror=alert(1)>";
    expect(popupView({ ...base, connected: true, label })).toEqual({
      tone: "wait",
      headline: "Waiting for approval",
      detail: ["Approve ", { strong: label }, " in Anbo: the browser menu at the top shows the request."],
      connected: true,
    });
    expect(popupView({ ...base, connected: true }).detail).toContain("this profile");
  });

  it("counts the tabs an approved profile has in Anbo", () => {
    const approved = { ...base, connected: true, approved: true, label: "Work" };
    expect(popupView({ ...approved, selected: 2 })).toMatchObject({ tone: "ok", headline: "Connected as Work", detail: ["2 tabs in Anbo."], connected: true });
    expect(popupView({ ...approved, selected: 1 }).detail).toEqual(["1 tab in Anbo."]);
    expect(popupView({ ...approved, selected: 0 }).detail).toEqual(["Open tabs from the browser menu at the top of Anbo, or from a new browser tab there."]);
    expect(popupView({ ...approved, label: "" }).headline).toBe("Connected");
  });

  it("says which action failed and keeps the last known connection", () => {
    expect(failureView("connect", new Error("Use a profile label of up to 64 characters, or leave it empty"), false)).toEqual({
      tone: "bad",
      headline: "Could not connect",
      detail: ["Use a profile label of up to 64 characters, or leave it empty"],
      connected: false,
    });
    expect(failureView("disconnect", "Browser bridge unavailable", true)).toMatchObject({ headline: "Could not disconnect", connected: true });
    expect(failureView("status", new Error("Browser bridge unavailable"), false).headline).toBe("Status unavailable");
  });

  it("sizes text on body, where Chrome's own extension style sets 75%", () => {
    const css = readFileSync(new URL("./popup.css", import.meta.url), "utf8");
    expect(css).toMatch(/^body \{[^}]*font: 13px/m);
  });
});
