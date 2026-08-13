import {
  listenFsChanged,
  parentDir,
  watchAdd,
  watchRemove,
} from "@/modules/explorer/lib/watch";
import type { Tab } from "@/modules/tabs";
import { type WorkspaceEnv, workspaceScopeKey } from "@/modules/workspace";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { type RefObject, useEffect, useRef } from "react";
import type { EditorPaneHandle } from "./EditorPane";

type Params = {
  tabs: Tab[];
  tabsRef: RefObject<Tab[]>;
  editorRefs: RefObject<Map<number, EditorPaneHandle>>;
  workspaceForSpace: (spaceId: string) => WorkspaceEnv;
};

/**
 * Keeps open editor tabs in sync with on-disk changes: reloads on applied AI
 * diffs, external writes, and fs-watch events, and maintains the watch set for
 * the directories of open editor files.
 */
export function useEditorFileSync({
  tabs,
  tabsRef,
  editorRefs,
  workspaceForSpace,
}: Params) {
  // When an AI diff is approved (write_file applied to disk), reload any
  // open editor tabs for that path so the user sees the new content. We
  // track which approvalIds we've already handled to fire the reload only
  // once per applied diff.
  const appliedDiffsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const t of tabs) {
      if (t.kind !== "ai-diff") continue;
      if (t.status !== "approved") continue;
      if (appliedDiffsRef.current.has(t.approvalId)) continue;
      appliedDiffsRef.current.add(t.approvalId);
      for (const e of tabs) {
        if (e.kind !== "editor") continue;
        if (e.path !== t.path) continue;
        editorRefs.current.get(e.id)?.reload();
      }
    }
  }, [tabs, editorRefs]);

  useEffect(() => {
    type FileWrittenPayload = { path: string; source?: string };
    const unlistenPromise =
      getCurrentWebviewWindow().listen<FileWrittenPayload>(
        "fs:file-written",
        (event) => {
          if (event.payload.source === "editor") return;
          const normalizedPath = event.payload.path.replace(/\\/g, "/");
          const currentTabs = tabsRef.current;
          for (const t of currentTabs) {
            if (t.kind !== "editor") continue;
            if (t.path.replace(/\\/g, "/") === normalizedPath) {
              editorRefs.current.get(t.id)?.reload();
            }
          }
        },
      );
    return () => {
      void unlistenPromise.then((un) => un());
    };
  }, [tabsRef, editorRefs]);

  const editorWatchRef = useRef(
    new Map<string, { workspace: WorkspaceEnv; paths: Set<string> }>(),
  );
  useEffect(() => {
    const want = new Map<
      string,
      { workspace: WorkspaceEnv; paths: Set<string> }
    >();
    for (const tab of tabs) {
      if (tab.kind !== "editor") continue;
      const workspace = workspaceForSpace(tab.spaceId);
      const key = workspaceScopeKey(workspace);
      let group = want.get(key);
      if (!group) {
        group = { workspace, paths: new Set() };
        want.set(key, group);
      }
      group.paths.add(parentDir(tab.path));
    }
    const prev = editorWatchRef.current;
    const keys = new Set([...want.keys(), ...prev.keys()]);
    for (const key of keys) {
      const nextGroup = want.get(key);
      const prevGroup = prev.get(key);
      if (nextGroup) {
        watchAdd(
          [...nextGroup.paths].filter((path) => !prevGroup?.paths.has(path)),
          nextGroup.workspace,
        );
      }
      if (prevGroup) {
        watchRemove(
          [...prevGroup.paths].filter((path) => !nextGroup?.paths.has(path)),
          prevGroup.workspace,
        );
      }
    }
    editorWatchRef.current = want;
  }, [tabs, workspaceForSpace]);

  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    void listenFsChanged((paths) => {
      const changed = new Set(paths.map((p) => p.replace(/\\/g, "/")));
      for (const t of tabsRef.current) {
        if (t.kind !== "editor") continue;
        if (changed.has(t.path.replace(/\\/g, "/"))) {
          editorRefs.current.get(t.id)?.reload();
        }
      }
    }).then((un) => {
      if (alive) unlisten = un;
      else un();
    });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [tabsRef, editorRefs]);
}
