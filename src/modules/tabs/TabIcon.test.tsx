import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Tab } from "./lib/useTabs";
import { TabIcon } from "./TabIcon";

type AgentState = "working" | "attention" | "finished" | null;

const data = vi.hoisted(() => ({ state: null as AgentState }));
vi.mock("@/modules/terminal", () => ({
  leafIds: () => [1],
  ptyIdForLeaf: () => 7,
  tabAgentStatus: () => ({ state: data.state, agent: null }),
  useAgentActivityStore: (select: (store: object) => unknown) =>
    select({ phases: {}, agents: {} }),
}));
vi.mock("@/modules/agents/store/agentResumeStatus", () => ({
  tabResumePhase: () => null,
  useAgentResumeStatus: (select: (store: object) => unknown) =>
    select({ status: {} }),
}));
vi.mock("@/modules/agents/lib/agentIcon", () => ({
  AgentIcon: ({ agent }: { agent: string }) => <i data-agent-logo={agent} />,
}));
vi.mock("@/modules/browser/browserInput", () => ({
  googleFaviconUrlForPage: () => null,
}));
vi.mock("@/modules/explorer/lib/iconResolver", () => ({
  fileIconUrl: () => "",
}));

const agentTab = {
  kind: "terminal",
  agent: { icon: "claude" },
  paneTree: {},
} as unknown as Tab;

function badge(state: AgentState) {
  data.state = state;
  return renderToStaticMarkup(<TabIcon tab={agentTab} />);
}

describe("an agent tab's status badge", () => {
  // A pulse by an animation that never ends drew the whole window at the
  // display rate for as long as an agent worked.
  it("beats by the shared timer while the agent works, with no animation of its own", () => {
    const html = badge("working");
    expect(html).toContain('aria-label="Agent working"');
    expect(html).toContain("anbo-beat bg-primary");
    expect(html).not.toMatch(/animate-/);
  });

  it("stays still for an agent that waits or has finished", () => {
    const attention = badge("attention");
    expect(attention).toContain("bg-amber-500");
    expect(attention).not.toContain("anbo-beat");
    const finished = badge("finished");
    expect(finished).toContain("bg-emerald-500");
    expect(finished).not.toContain("anbo-beat");
  });

  it("shows the logo alone for an agent that does nothing", () => {
    const html = badge(null);
    expect(html).toContain('data-agent-logo="claude"');
    expect(html).not.toMatch(/bg-(primary|amber-500|emerald-500)/);
  });
});
