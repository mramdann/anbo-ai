import type { TerminalTab } from "@/modules/tabs";
import { describe, expect, it } from "vitest";
import { terminalCloseCopy } from "./terminalCloseCopy";

function terminalTab(overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id: 1,
    kind: "terminal",
    spaceId: "default",
    title: "shell",
    paneTree: { kind: "leaf", id: 2 },
    activeLeafId: 2,
    ...overrides,
  };
}

describe("terminalCloseCopy", () => {
  it("identifies a named agent tab and its agent type", () => {
    const copy = terminalCloseCopy(
      terminalTab({
        agent: {
          launcherId: "antigravity",
          icon: "antigravity",
          label: "Antigravity",
          name: "Despina",
        },
      }),
    );

    expect(copy.title).toBe('Close "Despina"?');
    expect(copy.description).toContain('Antigravity agent "Despina"');
  });

  it("uses the visible custom terminal name", () => {
    const copy = terminalCloseCopy(
      terminalTab({ customTitle: "Development server" }),
    );

    expect(copy.title).toBe('Close "Development server"?');
    expect(copy.description).toContain('Terminal "Development server"');
  });

  it("keeps a safe fallback when the pending tab no longer exists", () => {
    expect(terminalCloseCopy(undefined)).toEqual({
      title: "Close Terminal?",
      description: "A process is running. Closing this tab will terminate it.",
    });
  });

  it("describes a split pane without claiming the whole tab will close", () => {
    expect(
      terminalCloseCopy(terminalTab({ customTitle: "Backend" }), "pane"),
    ).toEqual({
      title: 'Close pane in "Backend"?',
      description:
        "This pane has a running process. Closing it will terminate that process.",
    });
  });
});
