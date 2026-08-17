import type { WorkspaceEnv } from "@/modules/workspace";
import { native } from "./native";

const sessionShells = new Map<string, Promise<number>>();

export async function getPersistentShell(
  key: string,
  cwd: string | null,
  workspace: WorkspaceEnv,
): Promise<number> {
  const existing = sessionShells.get(key);
  if (existing) return existing;

  const opening = native.shellSessionOpen(cwd, workspace);
  sessionShells.set(key, opening);
  try {
    return await opening;
  } catch (error) {
    if (sessionShells.get(key) === opening) sessionShells.delete(key);
    throw error;
  }
}

export function releaseShellSessionsForChat(sessionId: string): void {
  const prefix = `${sessionId}:`;
  for (const [key, shell] of sessionShells) {
    if (!key.startsWith(prefix)) continue;
    sessionShells.delete(key);
    void shell
      .then((id) => native.shellSessionClose(id))
      .catch((error) =>
        console.warn("[anbo] failed to close AI shell session", error),
      );
  }
}
