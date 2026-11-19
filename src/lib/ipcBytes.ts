import { warn } from "@tauri-apps/plugin-log";

/**
 * Raw bytes as Tauri's IPC hands them to the page: an ArrayBuffer, or the
 * same bytes as an array of numbers.
 *
 * Tauri's page side sends each request over a protocol of its own. The first
 * time one such request fails, whatever the reason, it sends everything of
 * that page through `window.ipc.postMessage` for the rest of the page's life
 * (`customProtocolIpcFailed` in its ipc-protocol.js), and on that path Rust
 * answers raw bytes as a JSON array. A channel message of 1 KB or more is
 * fetched by a request, so from then on it arrives as `number[]`.
 *
 * Read as an ArrayBuffer, such a message throws and is gone. Measured (round
 * 114): with one request of the page made to fail, the next raw message of a
 * terminal's output arrived as `number[]`, and the terminal showed "[anbo:
 * 26397 bytes of output were lost]". A restart of the main window's network
 * service makes a request fail when one is in flight at that instant: on the
 * released 0.41.1 two restarts in eleven did, the first of them at once. From
 * 0.39.0 to 0.41.1 every terminal output message of 1 KB or more travelled
 * raw, so after one such failure a terminal showed that notice at each of
 * them until Anbo was restarted.
 */
export type IpcBytes = ArrayBuffer | ArrayBufferView | readonly number[];

let toldOfArrays = false;

export function ipcBytes(message: IpcBytes): ArrayBuffer {
  if (Array.isArray(message)) {
    if (!toldOfArrays) {
      toldOfArrays = true;
      // Once a window: Anbo's log then says when it took the slower path.
      void warn(
        "a request of this window over Tauri's IPC protocol failed, and its requests fell back to postMessage for good: raw bytes from Rust now arrive as arrays of numbers (slower, nothing lost)",
      ).catch(() => {});
    }
    return Uint8Array.from(message).buffer;
  }
  if (ArrayBuffer.isView(message)) {
    const { buffer, byteOffset, byteLength } = message;
    return buffer.slice(byteOffset, byteOffset + byteLength) as ArrayBuffer;
  }
  return message as ArrayBuffer;
}
