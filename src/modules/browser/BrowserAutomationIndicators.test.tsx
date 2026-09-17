import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AutomationState } from "./automationState";
import { BrowserAutomationIndicators } from "./BrowserAutomationIndicators";

const data = vi.hoisted(() => ({ participants: [] as AutomationState[] }));
vi.mock("./automationActivity", () => ({
  useBrowserAutomationParticipants: () => data.participants,
}));
vi.mock("@/modules/agents/lib/agentCallsign", () => ({
  useAgentCallsign: (pty: number) => `Agent ${pty}`,
}));
vi.mock("@/modules/agents/lib/agentIcon", () => ({
  AgentIcon: ({ agent }: { agent: string }) => <i data-agent-logo={agent} />,
}));

const state = (
  id: number,
  phase: AutomationState["phase"] = "running",
): AutomationState => ({
  tabId: 10,
  controlId: id,
  requestId: id,
  sequence: id,
  phase,
  method: "click",
  actor: { brand: "claude", label: "Claude", ptyId: id },
});

describe("browser tab actor group", () => {
  it("renders nothing without a live session", () => {
    data.participants = [];
    expect(
      renderToStaticMarkup(<BrowserAutomationIndicators tabId={10} />),
    ).toBe("");
  });
  it("shows two same-brand actors, individual names, statuses and a count", () => {
    data.participants = [state(1), state(2, "queued")];
    const html = renderToStaticMarkup(
      <BrowserAutomationIndicators tabId={10} />,
    );
    expect(html.match(/data-agent-logo=/g)).toHaveLength(2);
    expect(html).toContain("2 agents controlling this tab");
    expect(html).toContain("Agent 1: Clicking");
    expect(html).toContain("Agent 2: Waiting to act");
    expect(html).toContain('data-state="acting"');
    expect(html).toContain('data-state="held"');
  });
  it("caps visible logos at two while retaining accessible names for overflow", () => {
    data.participants = [state(1), state(2), state(3, "idle")];
    const html = renderToStaticMarkup(
      <BrowserAutomationIndicators tabId={10} />,
    );
    expect(html.match(/data-agent-logo=/g)).toHaveLength(2);
    expect(html).toContain("3 agents controlling this tab");
    expect(html).toContain(">+1</span>");
    expect(html).toContain("Agent 3: Idle, still holding this tab");
    expect(html).toContain('class="sr-only"');
  });
});
