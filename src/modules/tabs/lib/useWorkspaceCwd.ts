import { useCallback } from "react";

type Result = {
  explorerRoot: string | null;
  inheritedCwdForNewTab: () => string | undefined;
};

export function resolveWorkspacePaths(spaceRoot: string | null): {
  explorerRoot: string | null;
  newTabCwd: string | undefined;
} {
  return {
    explorerRoot: spaceRoot,
    newTabCwd: spaceRoot ?? undefined,
  };
}

export function useWorkspaceCwd(spaceRoot: string | null): Result {
  const paths = resolveWorkspacePaths(spaceRoot);

  const inheritedCwdForNewTab = useCallback(
    (): string | undefined => paths.newTabCwd,
    [paths.newTabCwd],
  );

  return { explorerRoot: paths.explorerRoot, inheritedCwdForNewTab };
}
