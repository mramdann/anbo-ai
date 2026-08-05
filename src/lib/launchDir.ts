import { invoke } from "@tauri-apps/api/core";

let cached: string | undefined;
// Benar hanya bila app diluncurkan dgn argumen folder eksplisit (CLI / "Open With").
// `workspace_current_dir` (fallback di bawah) SELALU bernilai karena Rust resolve_launch_dir()
// berakhir di dirs::home_dir() — jadi hanya `get_launch_dir` yang membedakan "user pilih folder"
// vs "cold-open jatuh ke home".
let explicit = false;

export async function initLaunchDir(): Promise<void> {
  const cliDir = await invoke<string | null>("get_launch_dir").catch(() => null);
  explicit = cliDir != null;
  const dir =
    cliDir ?? (await invoke<string | null>("workspace_current_dir").catch(() => null));
  cached = dir ? dir.replace(/\\/g, "/") : undefined;
}

export function getLaunchDir(): string | undefined {
  return cached;
}

/** App diluncurkan menargetkan folder spesifik (bukan cold-open ke home)? */
export function hasExplicitLaunchDir(): boolean {
  return explicit;
}

/**
 * Drains the files passed via the OS "Open With" action (CLI args on
 * Linux/Windows, macOS open-files event). Drained once so HMR / re-mounts
 * can't replay them. Returns [] when the app wasn't launched with a file.
 */
export async function consumeLaunchFiles(): Promise<string[]> {
  const files = await invoke<string[]>("get_launch_files").catch(() => []);
  return files.map((f) => f.replace(/\\/g, "/"));
}
