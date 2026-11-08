import type { BrowserTab, Tab, TerminalTab } from "@/modules/tabs/lib/useTabs";
import type { PaneNode } from "@/modules/terminal/lib/panes";
import { describe, expect, it } from "vitest";
import {
  newlyColdBrowserTabs,
  newlyColdLeaves,
  planSpacePause,
  spacePauseWorkLines,
  spaceResumeTabIds,
  spaceRunState,
  warmBrowserTabIds,
  warmTerminalLeaves,
} from "./pauseSpace";
import { hydrateTabs, serializeTabs } from "./serialize";

const SESSION = "0193b2a4-5c6d-7e8f-9a0b-1c2d3e4f5a6b";

function shell(over: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id: 1,
    kind: "terminal",
    spaceId: "work",
    title: "shell",
    cwd: "D:/work",
    paneTree: { kind: "leaf", id: 2, cwd: "D:/work" },
    activeLeafId: 2,
    ...over,
  };
}

function page(over: Partial<BrowserTab> = {}): BrowserTab {
  return {
    id: 5,
    kind: "browser",
    spaceId: "work",
    title: "Docs",
    url: "https://example.com/docs",
    ...over,
  };
}

const editor: Tab = {
  id: 9,
  kind: "editor",
  spaceId: "work",
  title: "a.ts",
  path: "D:/work/a.ts",
  dirty: false,
  preview: false,
};

function agentTab(paneTree: PaneNode): TerminalTab {
  return shell({
    id: 3,
    title: "Vega",
    agent: {
      launcherId: "claude",
      icon: "claude",
      label: "Claude",
      name: "Vega",
    },
    paneTree,
    activeLeafId: paneTree.id,
  });
}

function leafResume(tab: Tab | undefined) {
  if (tab?.kind !== "terminal" || tab.paneTree.kind !== "leaf")
    return undefined;
  return tab.paneTree.agentResume;
}

describe("spaceRunState", () => {
  it("is running while a shell or a page of Anbo's browser is warm", () => {
    expect(spaceRunState([shell()], "work")).toBe("running");
    expect(spaceRunState([shell({ cold: true }), page()], "work")).toBe(
      "running",
    );
  });

  it("is paused once every shell and page is cold, as after a restart", () => {
    expect(
      spaceRunState(
        [shell({ cold: true }), page({ cold: true }), editor],
        "work",
      ),
    ).toBe("paused");
  });

  it("counts neither editors nor Chrome/Edge tabs, nor other spaces", () => {
    const external = page({
      external: { browser: "chrome", profileId: "p", name: "Work" },
    });
    expect(spaceRunState([editor, external], "work")).toBe("idle");
    expect(spaceRunState([shell({ spaceId: "other" })], "work")).toBe("idle");
    expect(spaceRunState([], "work")).toBe("idle");
  });
});

describe("planSpacePause", () => {
  it("makes shells and pages cold with their ids, and leaves the rest", () => {
    const external = page({
      id: 6,
      external: { browser: "edge", profileId: "p", name: "Work" },
    });
    const elsewhere = shell({ id: 7, spaceId: "other" });
    const tabs: Tab[] = [
      shell(),
      page({ loading: true }),
      editor,
      external,
      elsewhere,
    ];
    const next = planSpacePause(tabs, "work");
    expect(next).not.toBeNull();
    const [term, browser, edit, chrome, other] = next as Tab[];
    expect(term).toMatchObject({ id: 1, cold: true, activeLeafId: 2 });
    expect(term.kind === "terminal" && term.paneTree).toMatchObject({ id: 2 });
    expect(browser).toMatchObject({
      id: 5,
      cold: true,
      url: "https://example.com/docs",
    });
    expect(browser).not.toHaveProperty("loading");
    expect(edit).toBe(editor);
    expect(chrome).toBe(external);
    expect(other).toBe(elsewhere);
  });

  it("has nothing to do for a space that already runs nothing", () => {
    expect(planSpacePause([shell({ cold: true }), editor], "work")).toBeNull();
    expect(planSpacePause([shell()], "other")).toBeNull();
  });

  it("keeps an agent's session so it resumes its conversation", () => {
    const [tab] = planSpacePause(
      [
        agentTab({
          kind: "leaf",
          id: 4,
          agentResume: {
            agent: "claude",
            command: "claude --dangerously-skip-permissions",
            armed: true,
            sessionId: SESSION,
            discoveryStartedAt: 123,
          },
        }),
      ],
      "work",
    ) as Tab[];
    expect(leafResume(tab)).toEqual({
      agent: "claude",
      command: "claude --dangerously-skip-permissions",
      sessionId: SESSION,
      armed: true,
      resumeOnStart: true,
    });
  });

  it("relaunches an agent whose session was not found yet, as a restart does", () => {
    const [tab] = planSpacePause(
      [
        agentTab({
          kind: "leaf",
          id: 4,
          agentResume: {
            agent: "claude",
            command: "claude",
            armed: false,
            relaunchOnRestore: true,
            discoveryStartedAt: 123,
          },
        }),
      ],
      "work",
    ) as Tab[];
    expect(leafResume(tab)).toEqual({
      agent: "claude",
      command: "claude",
      relaunchOnRestore: true,
      armed: true,
      resumeOnStart: true,
    });
  });

  it("does not start again an agent that had ended", () => {
    const [tab] = planSpacePause(
      [
        agentTab({
          kind: "leaf",
          id: 4,
          agentResume: { agent: "claude", command: "claude", armed: false },
        }),
      ],
      "work",
    ) as Tab[];
    expect(leafResume(tab)).toEqual({
      agent: "claude",
      command: "claude",
      armed: false,
    });
  });

  it("brings an agent tab back the way quitting and starting Anbo does", () => {
    const tabs: TerminalTab[] = [
      agentTab({
        kind: "leaf",
        id: 4,
        agentResume: {
          agent: "claude",
          command: "claude",
          armed: true,
          sessionId: SESSION,
        },
      }),
      agentTab({ kind: "leaf", id: 4 }),
      shell({
        paneTree: {
          kind: "split",
          id: 10,
          dir: "row",
          children: [
            { kind: "leaf", id: 11, cwd: "D:/work" },
            {
              kind: "leaf",
              id: 12,
              cwd: "D:/work/sub",
              agentResume: {
                agent: "codex",
                command: "codex",
                armed: false,
                relaunchOnRestore: true,
              },
            },
          ],
        },
        activeLeafId: 12,
      }),
    ];
    for (const tab of tabs) {
      const [paused] = planSpacePause([tab], "work") as TerminalTab[];
      const [restored] = hydrateTabs(
        serializeTabs([tab]),
        "work",
        (() => {
          let id = 500;
          return () => id++;
        })(),
      ) as TerminalTab[];
      const resumes = (t: TerminalTab) =>
        t.paneTree.kind === "leaf"
          ? [t.paneTree.agentResume]
          : t.paneTree.children.map((child) =>
              child.kind === "leaf" ? child.agentResume : undefined,
            );
      expect(resumes(paused)).toEqual(resumes(restored));
      expect(paused.cold).toBe(true);
    }
  });
});

describe("spaceResumeTabIds", () => {
  it("starts every cold shell and agent of the space and no page", () => {
    expect(
      spaceResumeTabIds(
        [
          shell({ cold: true }),
          shell({ id: 2 }),
          page({ cold: true }),
          shell({ id: 3, cold: true, spaceId: "other" }),
        ],
        "work",
      ),
    ).toEqual([1]);
  });
});

describe("cold transitions", () => {
  it("names the leaves and pages that went cold, not ones closed or never warm", () => {
    const before = [
      shell(),
      shell({
        id: 3,
        paneTree: {
          kind: "split",
          id: 20,
          dir: "col",
          children: [
            { kind: "leaf", id: 21 },
            { kind: "leaf", id: 22 },
          ],
        },
        activeLeafId: 21,
      }),
      shell({ id: 4, paneTree: { kind: "leaf", id: 40 }, activeLeafId: 40 }),
      page(),
      page({ id: 6 }),
    ];
    const warmLeaves = warmTerminalLeaves(before);
    const warmPages = warmBrowserTabIds(before);
    const after = [
      shell({ cold: true }),
      { ...before[1], cold: true },
      page({ cold: true }),
      shell({ id: 8, cold: true }),
    ];
    expect(newlyColdLeaves(warmLeaves, after)).toEqual([2, 21, 22]);
    expect(newlyColdBrowserTabs(warmPages, after)).toEqual([5]);
    expect(newlyColdLeaves(warmTerminalLeaves(after), after)).toEqual([]);
  });

  it("does not take a Chrome/Edge tab for a page of Anbo's browser", () => {
    expect([
      ...warmBrowserTabIds([
        page({ external: { browser: "chrome", profileId: "p", name: "W" } }),
      ]),
    ]).toEqual([]);
  });
});

describe("spacePauseWorkLines", () => {
  it("asks nothing when nothing is at work", () => {
    expect(
      spacePauseWorkLines({ agents: [], programs: [], pages: [] }),
    ).toEqual([]);
  });

  it("names what stops", () => {
    const lines = spacePauseWorkLines({
      agents: ["Vega"],
      programs: [{ tab: "web", names: ["node"] }],
      pages: ["Docs", "Search"],
    });
    expect(lines).toEqual([
      "An agent is in the middle of a task: Vega. The task stops; the agent resumes its conversation when the space comes back.",
      "A program is running: node in web. It ends, and the terminal opens a new shell when the space comes back.",
      "An agent is using 2 pages: Docs, Search. They close and load again when shown or used.",
    ]);
  });

  it("keeps a long list short", () => {
    const [line] = spacePauseWorkLines({
      agents: ["A", "B", "C", "D", "E", "F"],
      programs: [],
      pages: [],
    });
    expect(line).toContain(
      "6 agents are in the middle of a task: A, B, C, D and 2 more.",
    );
  });
});
