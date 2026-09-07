import type { TerminalTab } from "@/modules/tabs";
import { describe, expect, it } from "vitest";
import {
  retainTerminalClosePrompt,
  terminalCloseCopy,
} from "./terminalCloseCopy";

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

describe("terminal close prompt lifecycle", () => {
  const agent = (name = "Aurelia") =>
    terminalTab({
      agent: { launcherId: "claude", icon: "claude", label: "Claude", name },
    });

  it.each(["confirm", "cancel", "Escape"])(
    "retains the agent copy through %s and repeated closed renders",
    (action) => {
      const tab = agent();
      const open = retainTerminalClosePrompt(null, tab, tab.id, null);
      expect(open?.copy.title).toBe('Close "Aurelia"?');
      const closed = retainTerminalClosePrompt(
        open,
        action === "confirm" ? undefined : tab,
        null,
        null,
      );
      expect(closed?.copy).toBe(open?.copy);
      expect(closed?.tabId).toBeNull();
      expect(retainTerminalClosePrompt(closed, undefined, null, null)).toBe(
        closed,
      );
    },
  );

  it("does not replace the copy when the open target disappears or changes metadata", () => {
    const open = retainTerminalClosePrompt(null, agent(), 1, null);
    expect(retainTerminalClosePrompt(open, undefined, 1, null)).toBe(open);
    expect(retainTerminalClosePrompt(open, agent("Changed"), 1, null)).toBe(
      open,
    );
  });

  it("captures fresh copy when reopening the same tab", () => {
    const open = retainTerminalClosePrompt(null, agent(), 1, null);
    const closed = retainTerminalClosePrompt(open, agent(), null, null);
    const reopened = retainTerminalClosePrompt(closed, agent("Lyra"), 1, null);
    expect(reopened?.copy.title).toBe('Close "Lyra"?');
    expect(reopened?.copy).not.toBe(open?.copy);
  });

  it("retains pane wording after its pending leaf is cleared", () => {
    const open = retainTerminalClosePrompt(null, agent(), 1, 2);
    const closed = retainTerminalClosePrompt(open, undefined, null, null);
    expect(closed?.copy.title).toBe('Close pane in "Aurelia"?');
    expect(closed?.copy).toBe(open?.copy);
  });

  it("captures a different tab or pane without retaining the old target copy", () => {
    const open = retainTerminalClosePrompt(null, agent(), 1, null);
    const tab = terminalTab({ id: 3, customTitle: "Build" });
    const changed = retainTerminalClosePrompt(open, tab, 3, null);
    expect(changed?.copy.title).toBe('Close "Build"?');
    const pane = retainTerminalClosePrompt(changed, tab, 3, 4);
    expect(pane?.copy.title).toBe('Close pane in "Build"?');
    expect(retainTerminalClosePrompt(pane, tab, 3, 5)?.leafId).toBe(5);
  });

  it("does not create state while closed and accepts zero-valued IDs", () => {
    expect(retainTerminalClosePrompt(null, undefined, null, null)).toBeNull();
    const tab = terminalTab({ id: 0, customTitle: "Shell" });
    expect(retainTerminalClosePrompt(null, tab, 0, null)?.copy.title).toBe(
      'Close "Shell"?',
    );
  });
});
