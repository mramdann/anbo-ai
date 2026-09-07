import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { useWorkspaceEnvStore } from "@/modules/workspace";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { listenFsChanged, watchAdd, watchRemove } from "./watch";
import { renameTarget } from "./rename";
import { toast } from "sonner";
import { renameEntry, trashEntry } from "./pathMutations";

export type DirEntry = {
  name: string;
  kind: "file" | "dir" | "symlink";
  size: number;
  mtime: number;
  gitignored: boolean;
};

type ChildrenState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "loaded"; entries: DirEntry[] }
  | { status: "error"; message: string };

type TreeState = Record<string, ChildrenState>;

export type PendingCreate = {
  parentPath: string;
  kind: "file" | "dir";
};

export function joinPath(parent: string, name: string): string {
  if (parent.endsWith("/")) return `${parent}${name}`;
  return `${parent}/${name}`;
}

export function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  if (i <= 0) return "/";
  return path.slice(0, i);
}

const EXPANSION_CACHE_LIMIT = 8;
const expansionCache = new Map<string, string[]>();

function rememberExpansion(root: string, expanded: Set<string>): void {
  expansionCache.delete(root);
  if (expanded.size > 0) expansionCache.set(root, [...expanded]);
  while (expansionCache.size > EXPANSION_CACHE_LIMIT) {
    const oldest = expansionCache.keys().next().value;
    if (oldest === undefined) break;
    expansionCache.delete(oldest);
  }
}

function recallExpansion(root: string): string[] {
  const v = expansionCache.get(root);
  if (!v) return [];
  expansionCache.delete(root);
  expansionCache.set(root, v);
  return v;
}

function isUnder(key: string, root: string): boolean {
  return key === root || key.startsWith(`${root}/`);
}

// mtime/size are ignored on purpose: the tree never renders them, so a watcher
// refetch that only bumps mtime (saving a file) must not count as a change.
function sameDirListing(a: DirEntry[], b: DirEntry[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (
      a[i].name !== b[i].name ||
      a[i].kind !== b[i].kind ||
      a[i].gitignored !== b[i].gitignored
    )
      return false;
  }
  return true;
}

type Options = {
  onPathRenamed?: (from: string, to: string) => void;
  onBeforePathRename?: (path: string) => void;
  onBeforePathDelete?: (path: string) => void;
  onPathDeleted?: (path: string) => void;
};

export function useFileTree(rootPath: string | null, options?: Options) {
  const workspace = useWorkspaceEnvStore((state) => state.env);
  const showHidden = usePreferencesStore((s) => s.showHidden);
  const showHiddenRef = useRef(showHidden);
  const gitDecorations = usePreferencesStore((s) => s.explorerGitDecorations);
  const gitDecorationsRef = useRef(gitDecorations);
  const [nodes, setNodes] = useState<TreeState>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [pendingCreate, setPendingCreate] = useState<PendingCreate | null>(
    null,
  );
  const [renaming, setRenaming] = useState<string | null>(null);

  const expandedRef = useRef(expanded);
  const nodesRef = useRef(nodes);
  const watchedRef = useRef<Set<string>>(new Set());
  const generationRef = useRef(0);
  const mutationBusyRef = useRef(false);

  const mutate = useCallback(async (action: () => Promise<void>) => {
    if (mutationBusyRef.current)
      throw new Error(
        "Another file operation is in progress. Please try again.",
      );
    mutationBusyRef.current = true;
    try {
      await action();
    } finally {
      mutationBusyRef.current = false;
    }
  }, []);

  useEffect(() => {
    showHiddenRef.current = showHidden;
  }, [showHidden]);

  useEffect(() => {
    gitDecorationsRef.current = gitDecorations;
  }, [gitDecorations]);

  useEffect(() => {
    expandedRef.current = expanded;
  }, [expanded]);

  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);

  const addWatch = useCallback(
    (path: string) => {
      if (watchedRef.current.has(path)) return;
      watchedRef.current.add(path);
      watchAdd([path], workspace);
    },
    [workspace],
  );

  const removeWatch = useCallback(
    (path: string) => {
      if (!watchedRef.current.delete(path)) return;
      watchRemove([path], workspace);
    },
    [workspace],
  );

  const fetchChildren = useCallback(
    async (path: string) => {
      const generation = generationRef.current;
      if (nodesRef.current[path]?.status !== "loaded") {
        setNodes((s) => ({ ...s, [path]: { status: "loading" } }));
      }
      try {
        const entries = await invoke<DirEntry[]>("fs_read_dir", {
          path,
          showHidden: showHiddenRef.current,
          gitDecorations: gitDecorationsRef.current,
          workspace,
        });
        if (generation !== generationRef.current) return;

        const prev = nodesRef.current[path];
        if (
          prev?.status === "loaded" &&
          sameDirListing(prev.entries, entries)
        ) {
          return;
        }

        const liveDirs = new Set(
          entries
            .filter((e) => e.kind === "dir")
            .map((e) => joinPath(path, e.name)),
        );
        const removedRoots: string[] = [];
        for (const key of Object.keys(nodesRef.current)) {
          if (dirname(key) === path && !liveDirs.has(key))
            removedRoots.push(key);
        }
        const dead = new Set<string>();
        if (removedRoots.length > 0) {
          const candidates = new Set<string>([
            ...Object.keys(nodesRef.current),
            ...expandedRef.current,
            ...watchedRef.current,
          ]);
          for (const k of candidates) {
            if (removedRoots.some((r) => isUnder(k, r))) dead.add(k);
          }
        }

        setNodes((s) => {
          const next: TreeState = {};
          for (const [k, v] of Object.entries(s)) if (!dead.has(k)) next[k] = v;
          next[path] = { status: "loaded", entries };
          return next;
        });

        if (dead.size > 0) {
          setExpanded((c) => {
            let changed = false;
            const n = new Set(c);
            for (const d of dead) if (n.delete(d)) changed = true;
            return changed ? n : c;
          });
          const toUnwatch: string[] = [];
          for (const d of dead)
            if (watchedRef.current.delete(d)) toUnwatch.push(d);
          watchRemove(toUnwatch, workspace);
        }
      } catch (e) {
        if (generation !== generationRef.current) return;
        setNodes((s) => ({
          ...s,
          [path]: { status: "error", message: String(e) },
        }));
      }
    },
    [workspace],
  );

  // Root change → restore the cached expansion for this root, re-scope watches,
  // and persist the outgoing root's expansion on the way out.
  useEffect(() => {
    generationRef.current += 1;
    if (!rootPath) {
      setNodes({});
      setExpanded(new Set());
      setPendingCreate(null);
      setRenaming(null);
      return;
    }
    setPendingCreate(null);
    setRenaming(null);

    const restored = recallExpansion(rootPath);
    setExpanded(new Set(restored));
    setNodes({});
    // Sync the ref synchronously: nodesRef only updates after the next render,
    // so without this a fast (cached) fetchChildren below would read the stale
    // pre-clear "loaded" node, hit the sameDirListing early-return, and skip
    // re-populating — leaving a valid root with an empty tree when rootPath
    // changes rapidly (e.g. switching folders in quick succession).
    nodesRef.current = {};

    const toWatch = [rootPath, ...restored];
    void fetchChildren(rootPath);
    for (const d of restored) void fetchChildren(d);
    for (const p of toWatch) watchedRef.current.add(p);
    watchAdd(toWatch, workspace);

    return () => {
      rememberExpansion(rootPath, expandedRef.current);
      if (watchedRef.current.size > 0) {
        watchRemove([...watchedRef.current], workspace);
        watchedRef.current.clear();
      }
    };
  }, [rootPath, fetchChildren, workspace]);

  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    void listenFsChanged((paths) => {
      const current = nodesRef.current;
      const dirs = new Set<string>();
      for (const p of paths) {
        const parent = dirname(p);
        if (current[parent]?.status === "loaded") dirs.add(parent);
        if (current[p]?.status === "loaded") dirs.add(p);
      }
      for (const d of dirs) void fetchChildren(d);
    }).then((un) => {
      if (alive) unlisten = un;
      else un();
    });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [fetchChildren]);

  useEffect(() => {
    if (!rootPath) return;
    const loadedPaths = Object.entries(nodes)
      .filter(([, state]) => state.status === "loaded")
      .map(([path]) => path);
    for (const path of loadedPaths) void fetchChildren(path);
    // Re-list loaded directories when visibility or git-decoration prefs change.
    // `nodes` is intentionally omitted so ordinary tree edits don't refetch
    // every expanded directory.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showHidden, gitDecorations, rootPath, fetchChildren]);

  const toggle = useCallback(
    (path: string) => {
      if (expandedRef.current.has(path)) {
        setExpanded((curr) => {
          const next = new Set(curr);
          next.delete(path);
          return next;
        });
        removeWatch(path);
      } else {
        setExpanded((curr) => {
          const next = new Set(curr);
          next.add(path);
          return next;
        });
        addWatch(path);
        void fetchChildren(path);
      }
    },
    [fetchChildren, addWatch, removeWatch],
  );

  const expand = useCallback(
    (path: string) => {
      if (expandedRef.current.has(path)) return;
      setExpanded((curr) => {
        const next = new Set(curr);
        next.add(path);
        return next;
      });
      addWatch(path);
      void fetchChildren(path);
    },
    [fetchChildren, addWatch],
  );

  const refresh = useCallback(
    (path: string) => {
      void fetchChildren(path);
    },
    [fetchChildren],
  );

  // --- mutations ---

  const beginCreate = useCallback(
    (parentPath: string, kind: "file" | "dir") => {
      setRenaming(null);
      setPendingCreate({ parentPath, kind });
      // Ensure the parent is expanded so the input row is visible.
      if (rootPath && parentPath !== rootPath) {
        setExpanded((curr) => {
          if (curr.has(parentPath)) return curr;
          const next = new Set(curr);
          next.add(parentPath);
          return next;
        });
        addWatch(parentPath);
      }
      setNodes((curr) => {
        if (!curr[parentPath]) void fetchChildren(parentPath);
        return curr;
      });
    },
    [rootPath, fetchChildren, addWatch],
  );

  const cancelCreate = useCallback(() => setPendingCreate(null), []);

  const commitCreate = useCallback(
    async (name: string) => {
      if (!pendingCreate) return;
      const trimmed = name.trim();
      if (!trimmed) {
        setPendingCreate(null);
        return;
      }
      const path = joinPath(pendingCreate.parentPath, trimmed);
      const generation = generationRef.current;
      const cmd =
        pendingCreate.kind === "dir" ? "fs_create_dir" : "fs_create_file";
      await mutate(() => invoke(cmd, { path, workspace }));
      if (generation === generationRef.current) {
        setPendingCreate((current) =>
          current === pendingCreate ? null : current,
        );
        await fetchChildren(pendingCreate.parentPath);
      }
    },
    [pendingCreate, fetchChildren, workspace, mutate],
  );

  const beginRename = useCallback((path: string) => {
    setPendingCreate(null);
    setRenaming(path);
  }, []);

  const cancelRename = useCallback(() => setRenaming(null), []);

  const renamePath = useCallback(
    async (from: string, newName: string) => {
      const generation = generationRef.current;
      const to = renameTarget(from, newName);
      if (to === null) return;
      await mutate(() =>
        renameEntry({
          from,
          to,
          workspace,
          before: options?.onBeforePathRename,
          after: options?.onPathRenamed,
        }),
      );
      if (generation === generationRef.current)
        await fetchChildren(dirname(from));
    },
    [workspace, options, mutate, fetchChildren],
  );

  const commitRename = useCallback(
    async (newName: string) => {
      if (!renaming) return;
      const generation = generationRef.current;
      await renamePath(renaming, newName);
      if (generation === generationRef.current) {
        setRenaming((current) => (current === renaming ? null : current));
      }
    },
    [renaming, renamePath],
  );

  const deletePath = useCallback(
    async (path: string) => {
      const generation = generationRef.current;
      try {
        await mutate(() =>
          trashEntry({
            path,
            workspace,
            before: options?.onBeforePathDelete,
            after: options?.onPathDeleted,
          }),
        );
        if (generation === generationRef.current)
          await fetchChildren(dirname(path));
        toast.success("Moved to trash", {
          description:
            "You can restore it from your system trash or Recycle Bin.",
        });
      } catch (e) {
        toast.error("Could not move to trash", {
          description: e instanceof Error ? e.message : String(e),
        });
      }
    },
    [fetchChildren, options, workspace, mutate],
  );

  const movePath = useCallback(
    async (from: string, toDir: string) => {
      const name = from.slice(from.lastIndexOf("/") + 1);
      const to = joinPath(toDir, name);
      if (to === from) return;
      const generation = generationRef.current;
      try {
        await mutate(() =>
          renameEntry({
            from,
            to,
            workspace,
            before: options?.onBeforePathRename,
            after: options?.onPathRenamed,
          }),
        );
        if (generation === generationRef.current)
          await Promise.all([
            fetchChildren(dirname(from)),
            fetchChildren(toDir),
          ]);
      } catch (e) {
        toast.error("Could not move", {
          description: e instanceof Error ? e.message : String(e),
        });
      }
    },
    [fetchChildren, options, workspace, mutate],
  );

  return {
    nodes,
    expanded,
    pendingCreate,
    renaming,
    toggle,
    expand,
    refresh,
    beginCreate,
    cancelCreate,
    commitCreate,
    beginRename,
    cancelRename,
    commitRename,
    renamePath,
    deletePath,
    movePath,
    joinPath,
  };
}
