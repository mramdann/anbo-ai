import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const announceSource = readFileSync(
  new URL(
    "../../../src-tauri/src/modules/browser_automation/announce.js",
    import.meta.url,
  ),
  "utf8",
);

type Region = {
  role?: string;
  live?: string;
  textContent: string;
  shown: boolean;
  hidden?: boolean;
  children?: Region[];
  getAttribute: (name: string) => string | null;
  contains: (other: Region) => boolean;
};

function region(
  textContent: string,
  options: { role?: string; live?: string; shown?: boolean } = {},
): Region {
  const node: Region = {
    textContent,
    shown: options.shown ?? true,
    getAttribute: (name) =>
      name === "role"
        ? (options.role ?? null)
        : name === "aria-live"
          ? (options.live ?? null)
          : null,
    contains: (other) => other === node,
  };
  return node;
}

function page(regions: Region[]) {
  const context = vm.createContext({
    isRenderedElement: (node: Region) => node.shown,
    document: { querySelectorAll: () => regions },
  });
  vm.runInContext(announceSource, context);
  const target = {};
  return {
    press: () => {
      context.target = target;
      vm.runInContext("captureAnnounceBaseline(target)", context);
    },
    read: (other?: object) => {
      context.target = other ?? target;
      return vm.runInContext(
        "JSON.stringify(readAnnounced(target, 3))",
        context,
      );
    },
  };
}

describe("live region messages a click posts", () => {
  it("reports a status the click filled and an alert it showed", () => {
    const status = region("", { role: "status" });
    const alert = region("Email is required", { role: "alert", shown: false });
    const quiet = region("Unread: 3", { live: "polite" });
    const tab = page([status, alert, quiet]);
    tab.press();
    status.textContent = "Terdaftar: Rina";
    alert.shown = true;
    expect(JSON.parse(tab.read())).toEqual([
      { role: "status", text: "Terdaftar: Rina" },
      { role: "alert", text: "Email is required" },
    ]);
  });

  it("reports only the new part of a log, and an assertive region as an alert", () => {
    const log = region("Budi: pagi Sari: siang", { role: "log" });
    const banner = region("", { live: "assertive" });
    const tab = page([log, banner]);
    tab.press();
    log.textContent = "Budi: pagi Sari: siang Rina: halo";
    banner.textContent = "Connection lost";
    expect(JSON.parse(tab.read())).toEqual([
      { role: "log", text: "Rina: halo" },
      { role: "alert", text: "Connection lost" },
    ]);
  });

  it("says nothing for unchanged or hidden regions, and only once per press", () => {
    const status = region("Saved", { role: "status" });
    const hidden = region("", { role: "alert", shown: false });
    const tab = page([status, hidden]);
    tab.press();
    hidden.textContent = "Still hidden";
    expect(JSON.parse(tab.read())).toEqual([]);
    status.textContent = "Saved again";
    expect(JSON.parse(tab.read())).toEqual([]);
  });

  it("belongs to the element that was pressed", () => {
    const status = region("", { role: "status" });
    const tab = page([status]);
    tab.press();
    status.textContent = "Done";
    expect(JSON.parse(tab.read({}))).toEqual([]);
  });

  it("clips a long message at 300 characters", () => {
    const status = region("", { role: "status" });
    const tab = page([status]);
    tab.press();
    status.textContent = "x".repeat(400);
    const [entry] = JSON.parse(tab.read());
    expect(entry.text).toHaveLength(300);
    expect(entry.text.endsWith("…")).toBe(true);
  });
});
