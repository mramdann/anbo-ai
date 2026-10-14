import { invoke } from "@tauri-apps/api/core";

/**
 * Answers one of Anbo's requests to this window: the agent and terminal
 * tools, opening, closing and listing browser tabs, and bringing a Chrome or
 * Edge tab forward before input. The answer goes straight to the request
 * waiting for it (`ui_answer.rs`); as an event to a one-time Rust listener it
 * was lost now and then when requests overlapped. Resolves whether Anbo was
 * still waiting for it.
 */
export function replyToAnbo(
  requestId: string,
  response: unknown,
): Promise<boolean> {
  return invoke<boolean>("ui_reply", { requestId, response }).catch(
    (cause: unknown) => {
      console.warn("[anbo] could not answer request", requestId, cause);
      return false;
    },
  );
}
