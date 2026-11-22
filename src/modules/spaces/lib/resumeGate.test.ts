import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  BrowserTab,
  EditorTab,
  Tab,
  TerminalTab,
} from "@/modules/tabs/lib/useTabs";
import { describe, expect, it } from "vitest";
import {
  awaitsResume,
  resumeGateShown,
  resumeSummary,
  resumeSummaryLine,
  sleepingTabIds,
  spacesWithTabs,
  staysAsleep,
} from "./resumeGate";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (file: string) => readFileSync(path.join(here, file), "utf8");

function shell(over: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id: 1,
    kind: "terminal",
    spaceId: "work",
    cold: true,
    title: "shell",
    cwd: "D:/work",
    paneTree: { kind: "leaf", id: 2, cwd: "D:/work" },
    activeLeafId: 2,
    ...over,
  };
}

function agent(id: number, name: string, over: Partial<TerminalTab> = {}) {
  return shell({
    id,
    agent: { launcherId: "claude", name } as TerminalTab["agent"],
    ...over,
  });
}

function page(over: Partial<BrowserTab> = {}): BrowserTab {
  return {
    id: 5,
    kind: "browser",
    spaceId: "work",
    cold: true,
    title: "Docs",
    url: "https://example.com/docs",
    ...over,
  };
}

function file(over: Partial<EditorTab> = {}): EditorTab {
  return {
    id: 7,
    kind: "editor",
    spaceId: "work",
    cold: true,
    title: "notes.md",
    path: "D:/work/notes.md",
    dirty: false,
    preview: false,
    ...over,
  };
}

const waiting = new Set(["work"]);
const nobody = new Set<string>();

describe("spacesWithTabs", () => {
  it("names each workspace that came back with tabs once", () => {
    const tabs: Tab[] = [shell(), page(), shell({ id: 9, spaceId: "other" })];
    expect(spacesWithTabs(tabs)).toEqual(["work", "other"]);
    expect(spacesWithTabs([])).toEqual([]);
  });
});

describe("awaitsResume", () => {
  it("holds while the workspace is pending and something of it sleeps", () => {
    expect(awaitsResume(waiting, [shell()], "work")).toBe(true);
  });

  it("ends with the user's word, and when nothing sleeps any more", () => {
    expect(awaitsResume(nobody, [shell()], "work")).toBe(false);
    expect(awaitsResume(waiting, [shell({ cold: false })], "work")).toBe(false);
    expect(awaitsResume(waiting, [], "work")).toBe(false);
  });

  it("is each workspace's own", () => {
    expect(awaitsResume(waiting, [shell({ spaceId: "other" })], "work")).toBe(
      false,
    );
    expect(awaitsResume(waiting, [shell({ spaceId: "other" })], "other")).toBe(
      false,
    );
  });
});

describe("staysAsleep", () => {
  it("keeps a sleeping tab of a waiting workspace asleep", () => {
    expect(staysAsleep(waiting, shell())).toBe(true);
    expect(staysAsleep(waiting, page())).toBe(true);
    expect(staysAsleep(waiting, file())).toBe(true);
  });

  it("lets every other tab wake as before", () => {
    expect(staysAsleep(nobody, shell())).toBe(false);
    expect(staysAsleep(waiting, shell({ cold: false }))).toBe(false);
    expect(staysAsleep(waiting, shell({ spaceId: "other" }))).toBe(false);
    expect(staysAsleep(waiting, undefined)).toBe(false);
  });
});

describe("resumeGateShown", () => {
  it("shows while the tab in view is a sleeping tab of the workspace", () => {
    expect(resumeGateShown(waiting, [shell()], "work", 1)).toBe(true);
  });

  it("shows when no tab of the workspace is in view", () => {
    expect(resumeGateShown(waiting, [shell()], "work", -1)).toBe(true);
    const tabs = [shell(), shell({ id: 9, spaceId: "other", cold: false })];
    expect(resumeGateShown(waiting, tabs, "work", 9)).toBe(true);
  });

  it("steps aside for a tab opened since, and comes back for a sleeping one", () => {
    const tabs = [shell(), shell({ id: 3, cold: false })];
    expect(resumeGateShown(waiting, tabs, "work", 3)).toBe(false);
    expect(resumeGateShown(waiting, tabs, "work", 1)).toBe(true);
  });

  it("is gone once the user has answered", () => {
    expect(resumeGateShown(nobody, [shell()], "work", 1)).toBe(false);
  });
});

describe("sleepingTabIds", () => {
  it("lists what a fresh start closes: the sleeping tabs, not one opened since", () => {
    const tabs: Tab[] = [
      shell(),
      shell({ id: 3, cold: false }),
      page(),
      shell({ id: 9, spaceId: "other" }),
    ];
    expect(sleepingTabIds(tabs, "work")).toEqual([1, 5]);
  });
});

describe("resumeSummary", () => {
  const tabs: Tab[] = [
    agent(10, "Claude"),
    agent(11, "Proclus"),
    shell({ id: 12, customTitle: "server" }),
    page({ id: 13, title: "localhost" }),
    file({ id: 14 }),
    shell({ id: 15, cold: false, customTitle: "new" }),
    shell({ id: 16, spaceId: "other" }),
  ];

  it("counts the sleeping tabs by kind and names the agents", () => {
    const summary = resumeSummary(tabs, "work");
    expect(summary.agents).toEqual(["Claude", "Proclus"]);
    expect(summary.terminals).toBe(1);
    expect(summary.pages).toBe(1);
    expect(summary.files).toBe(1);
    expect(summary.others).toBe(0);
    expect(summary.titles).toEqual([
      "Claude",
      "Proclus",
      "server",
      "localhost",
      "notes.md",
    ]);
  });

  it("reads as one line, with only the kinds that are there", () => {
    expect(resumeSummaryLine(resumeSummary(tabs, "work"))).toBe(
      "2 agents, 1 terminal, 1 browser tab, 1 file",
    );
    expect(resumeSummaryLine(resumeSummary([shell()], "work"))).toBe(
      "1 terminal",
    );
    expect(
      resumeSummaryLine(
        resumeSummary([page(), page({ id: 6 }), file()], "work"),
      ),
    ).toBe("2 browser tabs, 1 file");
  });
});

describe("where the rule is applied", () => {
  it("keeps the activation choke point from waking a waiting workspace's tab", () => {
    const tabsSource = read("../../tabs/lib/useTabs.ts");
    expect(tabsSource).toContain(
      "if (!t?.cold || staysAsleep(resumePending, t)) return curr;",
    );
    expect(tabsSource).toContain("}, [activeId, booted, resumePending]);");
  });

  it("keeps the agent rule and the layout's reveals from waking it", () => {
    const app = read("../../../app/App.tsx");
    expect(app).toMatch(
      /!staysAsleep\(resumePending, tab\) &&\s+shouldWarmAgentTabOnReopen\(tab, activeSpaceId\)/,
    );
    expect(app).toContain("onRevealTab={revealTab}");
    // Its identity follows the answers: the panels in view reveal again on resume.
    expect(app).toMatch(
      /if \(!staysAsleep\(resumePending, tab\)\) warmTab\(id\);\s+\},\s+\[resumePending, warmTab\],/,
    );
    expect(app).not.toContain("onRevealTab={warmTab}");
    expect(app).toContain("visible && !resumeGateOpen ? tab.id : -1");
  });

  it("asks at boot for the workspaces that came back, before a shell made for a folder joins", () => {
    const boot = read("useSpacesBoot.ts");
    const asked = boot.indexOf(
      "useResumeGate.getState().ask(spacesWithTabs(restored));",
    );
    const fresh = boot.indexOf("restored.push(freshTerminalTab(");
    expect(asked).toBeGreaterThan(0);
    expect(fresh).toBeGreaterThan(asked);
  });

  it("asks again after a pause by hand and stops asking after a resume by hand", () => {
    const tabsSource = read("../../tabs/lib/useTabs.ts");
    expect(tabsSource).toContain("useResumeGate.getState().ask([spaceId]);");
    expect(tabsSource).toContain("useResumeGate.getState().release(spaceId);");
  });
});
