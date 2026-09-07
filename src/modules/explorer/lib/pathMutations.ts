import { invoke } from "@tauri-apps/api/core";
import type { WorkspaceEnv } from "@/modules/workspace";

export async function renameEntry(options: {
  from: string;
  to: string;
  workspace: WorkspaceEnv;
  before?: (path: string) => void;
  after?: (from: string, to: string) => void;
}): Promise<void> {
  const { from, to, workspace, before, after } = options;
  before?.(from);
  await invoke("fs_rename", { from, to, workspace });
  after?.(from, to);
}

export async function trashEntry(options: {
  path: string;
  workspace: WorkspaceEnv;
  before?: (path: string) => void;
  after?: (path: string) => void;
}): Promise<void> {
  const { path, workspace, before, after } = options;
  before?.(path);
  await invoke("fs_trash", { path, workspace });
  after?.(path);
}
