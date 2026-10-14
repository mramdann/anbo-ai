import type { AppCloseBlocker } from "@/app/hooks/useAppCloseGuard";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import type { Tab } from "@/modules/tabs";
import { useState } from "react";
import {
  type IdleAgentTab,
  idleAgentLabel,
} from "../lib/terminalCapacityNotice";
import {
  retainTerminalClosePrompt,
  terminalCloseCopy,
  type TerminalClosePrompt,
} from "../lib/terminalCloseCopy";

type Props = {
  tabs: Tab[];
  pendingCloseTab: number | null;
  onCancelClose: () => void;
  onConfirmClose: () => void;
  pendingTerminalCloseTab: number | null;
  pendingTerminalCloseLeaf: number | null;
  onCancelTerminalClose: () => void;
  onConfirmTerminalClose: () => void;
  pendingDeleteTabs: number[] | null;
  onCancelDeleteClose: () => void;
  onConfirmDeleteClose: () => void;
  pendingIdleAgents: IdleAgentTab[] | null;
  onCancelIdleAgentClose: () => void;
  onConfirmIdleAgentClose: () => void;
  pendingAppClose: AppCloseBlocker | null;
  onCancelAppClose: () => void;
  onConfirmAppClose: () => void;
};

function appCloseMessage(blocker: AppCloseBlocker): string {
  if (blocker.persistenceError) {
    return `Anbo could not save the latest workspace state: ${blocker.persistenceError}. Quit anyway?`;
  }
  const dirty =
    blocker.dirtyEditors === 1
      ? "1 file has unsaved changes"
      : `${blocker.dirtyEditors} files have unsaved changes`;
  if (blocker.dirtyEditors > 0 && blocker.busyTerminal) {
    return `A process is still running and ${dirty}. Quitting will terminate it and discard the changes.`;
  }
  if (blocker.dirtyEditors > 0) {
    return `${dirty.charAt(0).toUpperCase()}${dirty.slice(1)}. Quitting will discard them.`;
  }
  return "A process is still running in a terminal. Quitting will terminate it.";
}

const LISTED_AGENTS = 8;

function idleAgentsMessage(agents: IdleAgentTab[]): string {
  const names = agents.slice(0, LISTED_AGENTS).map(idleAgentLabel);
  const more = agents.length - names.length;
  const list =
    more > 0 ? `${names.join(", ")} and ${more} more` : names.join(", ");
  return agents.length === 1
    ? `Its CLI ends and its tab closes, which frees its live buffer: ${list}.`
    : `Their CLIs end and their tabs close, which frees their live buffers: ${list}.`;
}

/** Confirmation dialogs for closing dirty editors and terminals with live processes. */
export function CloseDialogs({
  tabs,
  pendingCloseTab,
  onCancelClose,
  onConfirmClose,
  pendingTerminalCloseTab,
  pendingTerminalCloseLeaf,
  onCancelTerminalClose,
  onConfirmTerminalClose,
  pendingDeleteTabs,
  onCancelDeleteClose,
  onConfirmDeleteClose,
  pendingIdleAgents,
  onCancelIdleAgentClose,
  onConfirmIdleAgentClose,
  pendingAppClose,
  onCancelAppClose,
  onConfirmAppClose,
}: Props) {
  const [terminalPrompt, setTerminalPrompt] =
    useState<TerminalClosePrompt | null>(null);
  const nextTerminalPrompt = retainTerminalClosePrompt(
    terminalPrompt,
    tabs.find((tab) => tab.id === pendingTerminalCloseTab),
    pendingTerminalCloseTab,
    pendingTerminalCloseLeaf,
  );
  if (nextTerminalPrompt !== terminalPrompt)
    setTerminalPrompt(nextTerminalPrompt);
  const terminalCopy = nextTerminalPrompt?.copy ?? terminalCloseCopy(undefined);

  return (
    <>
      <AlertDialog
        open={pendingCloseTab !== null}
        onOpenChange={(open) => !open && onCancelClose()}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unsaved Changes</AlertDialogTitle>
            <AlertDialogDescription>
              {tabs.find((t) => t.id === pendingCloseTab)?.title
                ? `"${
                    tabs.find((t) => t.id === pendingCloseTab)?.title
                  }" has unsaved changes. Close anyway?`
                : "This file has unsaved changes. Close anyway?"}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={onCancelClose}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction onClick={onConfirmClose}>
              Close Anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={pendingTerminalCloseTab !== null}
        onOpenChange={(open) => !open && onCancelTerminalClose()}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{terminalCopy.title}</AlertDialogTitle>
            <AlertDialogDescription>
              {terminalCopy.description}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={onCancelTerminalClose}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction onClick={onConfirmTerminalClose}>
              Close Anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={pendingDeleteTabs !== null}
        onOpenChange={(open) => !open && onCancelDeleteClose()}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unsaved Changes</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDeleteTabs?.length === 1
                ? (() => {
                    const title = tabs.find(
                      (t) => t.id === pendingDeleteTabs[0],
                    )?.title;
                    return title
                      ? `"${title}" has unsaved changes. The file has been deleted. Close anyway?`
                      : "This file has unsaved changes. The file has been deleted. Close anyway?";
                  })()
                : `${pendingDeleteTabs?.length ?? 0} files have unsaved changes. They have been deleted. Close all anyway?`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={onCancelDeleteClose}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction onClick={onConfirmDeleteClose}>
              Close Anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={pendingIdleAgents !== null}
        onOpenChange={(open) => !open && onCancelIdleAgentClose()}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingIdleAgents?.length === 1
                ? "Close 1 waiting agent?"
                : `Close ${pendingIdleAgents?.length ?? 0} waiting agents?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingIdleAgents ? idleAgentsMessage(pendingIdleAgents) : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={onCancelIdleAgentClose}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction onClick={onConfirmIdleAgentClose}>
              Close Agents
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={pendingAppClose !== null}
        onOpenChange={(open) => !open && onCancelAppClose()}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Quit Anbo?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingAppClose ? appCloseMessage(pendingAppClose) : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={onCancelAppClose}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction onClick={onConfirmAppClose}>
              Quit Anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
