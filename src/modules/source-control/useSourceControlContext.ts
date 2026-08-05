import { native } from "@/modules/ai/lib/native";
import type { SidebarViewId } from "@/modules/sidebar";
import { useCallback } from "react";
import { useSourceControl } from "./useSourceControl";

type Params = {
  explorerRoot: string | null;
  cycleSidebarView: (view: SidebarViewId) => void;
  openCommitHistoryTab: (args: {
    repoRoot: string;
    branch: string | null;
  }) => void;
};

export function workspaceSourceControlPath(
  explorerRoot: string | null,
): string | null {
  return explorerRoot;
}

/**
 * Keeps source control scoped to the configured workspace root. Terminal `cd`
 * and editor selection must not move the repository context away from it.
 */
export function useSourceControlContext({
  explorerRoot,
  cycleSidebarView,
  openCommitHistoryTab,
}: Params) {
  const sourceControlContextPath = workspaceSourceControlPath(explorerRoot);
  const sourceControl = useSourceControl(sourceControlContextPath, true);

  const toggleSourceControl = useCallback(() => {
    cycleSidebarView("source-control");
  }, [cycleSidebarView]);

  const openGitGraphFromContext = useCallback(async () => {
    const known = sourceControl.hasRepo ? sourceControl.repo : null;
    if (known) {
      openCommitHistoryTab({
        repoRoot: known.repoRoot,
        branch: sourceControl.status?.branch ?? null,
      });
      return;
    }
    if (!sourceControlContextPath) return;
    try {
      const repo = await native.gitResolveRepo(sourceControlContextPath);
      if (!repo) return;
      openCommitHistoryTab({ repoRoot: repo.repoRoot, branch: repo.branch });
    } catch {
      /* noop */
    }
  }, [
    openCommitHistoryTab,
    sourceControl.hasRepo,
    sourceControl.repo,
    sourceControl.status?.branch,
    sourceControlContextPath,
  ]);

  return { sourceControl, toggleSourceControl, openGitGraphFromContext };
}
