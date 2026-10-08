import { invoke } from "@tauri-apps/api/core";

// WebKitGTK can't read external copies, so the native plugin is Linux-only and
// lazy-loaded to keep it out of the mac/win bundle.
const IS_LINUX =
  typeof navigator !== "undefined" &&
  /Linux/.test(navigator.userAgent) &&
  !/Android/.test(navigator.userAgent);
// WebView2's navigator.clipboard.readText asks for a permission in a small
// prompt first, so Windows reads the clipboard natively (clipboard.rs).
const IS_WINDOWS =
  typeof navigator !== "undefined" && /Windows/.test(navigator.userAgent);

function webClipboard(): Clipboard | null {
  if (typeof navigator === "undefined") return null;
  return navigator.clipboard ?? null;
}

/** The clipboard's text. On Windows null means it holds no text (an image,
 * files), and a read that failed rejects. */
export async function readTerminalClipboard(): Promise<string | null> {
  if (IS_WINDOWS) return invoke<string | null>("clipboard_read_text");
  if (IS_LINUX) {
    try {
      const { readText } = await import("@tauri-apps/plugin-clipboard-manager");
      return await readText();
    } catch {}
  }
  try {
    return (await webClipboard()?.readText()) ?? "";
  } catch {
    return "";
  }
}

export async function writeTerminalClipboard(text: string): Promise<void> {
  if (IS_LINUX) {
    try {
      const { writeText } = await import(
        "@tauri-apps/plugin-clipboard-manager"
      );
      await writeText(text);
      return;
    } catch {}
  }
  try {
    await webClipboard()?.writeText(text);
  } catch {}
}
