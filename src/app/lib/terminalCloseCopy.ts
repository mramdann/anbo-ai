import { labelFor, type Tab } from "@/modules/tabs";

export type TerminalCloseCopy = {
  title: string;
  description: string;
};

export function terminalCloseCopy(
  tab: Tab | undefined,
  scope: "tab" | "pane" = "tab",
): TerminalCloseCopy {
  if (scope === "pane") {
    const name = tab ? labelFor(tab) : "Terminal";
    return {
      title: `Close pane in "${name}"?`,
      description:
        "This pane has a running process. Closing it will terminate that process.",
    };
  }
  if (tab?.kind !== "terminal") {
    return {
      title: "Close Terminal?",
      description: "A process is running. Closing this tab will terminate it.",
    };
  }

  const name = labelFor(tab);
  if (!tab.agent) {
    return {
      title: `Close "${name}"?`,
      description: `Terminal "${name}" has a running process. Closing this tab will terminate every process in it.`,
    };
  }

  const agentName =
    tab.agent.label.toLocaleLowerCase() === name.toLocaleLowerCase()
      ? `${tab.agent.label} agent`
      : `${tab.agent.label} agent "${name}"`;
  return {
    title: `Close "${name}"?`,
    description: `${agentName} has a running process. Closing this tab will terminate every process in it.`,
  };
}
