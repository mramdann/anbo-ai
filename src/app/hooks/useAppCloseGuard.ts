import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { Tab } from "@/modules/tabs";
import { leafHasForegroundProcess, leafIds } from "@/modules/terminal";

async function anyTerminalBusy(tabs: Tab[]): Promise<boolean> {
  const leaves = tabs.flatMap((t) =>
    t.kind === "terminal" ? leafIds(t.paneTree) : [],
  );
  if (leaves.length === 0) return false;
  const checks = await Promise.all(leaves.map(leafHasForegroundProcess));
  return checks.some(Boolean);
}

export type AppCloseBlocker = {
  dirtyEditors: number;
  busyTerminal: boolean;
  persistenceError?: string;
};

export function useAppCloseGuard(
  tabsRef: RefObject<Tab[]>,
  beforeClose?: () => Promise<void>,
) {
  const [pendingAppClose, setPendingAppClose] =
    useState<AppCloseBlocker | null>(null);
  const forceClose = useRef(false);

  const closeAfterFlush = useCallback(async () => {
    try {
      await beforeClose?.();
    } catch (error) {
      setPendingAppClose({
        dirtyEditors: 0,
        busyTerminal: false,
        persistenceError: String(error),
      });
      return;
    }
    forceClose.current = true;
    void getCurrentWindow().close();
  }, [beforeClose]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void getCurrentWindow()
      .onCloseRequested(async (event) => {
        if (forceClose.current) return;
        event.preventDefault();
        const busyTerminal = await anyTerminalBusy(tabsRef.current);
        // Count after the await so edits made during the IPC check are seen.
        const dirtyEditors = tabsRef.current.filter(
          (t) => t.kind === "editor" && t.dirty,
        ).length;
        if (dirtyEditors > 0 || busyTerminal) {
          setPendingAppClose({ dirtyEditors, busyTerminal });
        } else {
          await closeAfterFlush();
        }
      })
      .then((un) => {
        if (disposed) un();
        else unlisten = un;
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [tabsRef, closeAfterFlush]);

  const confirmAppClose = useCallback(() => {
    if (!pendingAppClose) return;
    setPendingAppClose(null);
    if (pendingAppClose.persistenceError) {
      forceClose.current = true;
      void getCurrentWindow().close();
      return;
    }
    void closeAfterFlush();
  }, [pendingAppClose, closeAfterFlush]);

  const cancelAppClose = useCallback(() => setPendingAppClose(null), []);

  return { pendingAppClose, confirmAppClose, cancelAppClose };
}
