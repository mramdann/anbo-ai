import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";

/** The HTTP MCP endpoint as the backend reports it (`http::McpStatus`). */
export type McpStatus = {
  state: "off" | "starting" | "listening" | "failed";
  url: string;
  error: string | null;
  inUse: boolean;
  holder: { pid: number; name: string | null } | null;
};

const STATUS_EVENT = "anbo://mcp-status";
const TOAST_ID = "anbo-mcp-port";

function portOf(url: string): string {
  try {
    return new URL(url).port || url;
  } catch {
    return url;
  }
}

export function describeMcpFailure(status: McpStatus): string {
  const port = portOf(status.url);
  if (!status.inUse) {
    const reason = status.error ? ` (${status.error})` : "";
    return `Anbo could not open port ${port} for its browser tools${reason}.`;
  }
  const holder = status.holder
    ? `${status.holder.name ?? "another app"} (PID ${status.holder.pid})`
    : "another app";
  return `Port ${port} is in use by ${holder}, so agents cannot reach Anbo's browser. Close it, then retry.`;
}

/**
 * Every agent Anbo sets up is configured with the endpoint's fixed URL, so
 * while another app holds the port the agents talk to that app instead. Say
 * so until the port is free again, with a retry for after the user closed it.
 * A healthy endpoint costs one status read at start and nothing after.
 */
export function watchMcpPort(): () => void {
  let disposed = false;
  let failing = false;
  let unlisten: (() => void) | undefined;

  const show = (status: McpStatus) => {
    if (disposed) return;
    if (status.state === "failed") {
      failing = true;
      toast.warning("Browser tools are offline", {
        id: TOAST_ID,
        description: describeMcpFailure(status),
        duration: Number.POSITIVE_INFINITY,
        action: {
          label: "Retry",
          // Keep the warning up while retrying: sonner closes a toast on an
          // action click, and the answer would land on a closing toast.
          onClick: (event) => {
            event.preventDefault();
            void retry();
          },
        },
      });
      return;
    }
    if (!failing || status.state === "starting") return;
    failing = false;
    if (status.state === "listening") {
      // Same id, so sonner merges into the warning: drop its Retry and its
      // endless duration explicitly.
      toast.success("Browser tools are back", {
        id: TOAST_ID,
        description: `Agents can reach ${status.url} again.`,
        duration: 4_000,
        action: undefined,
      });
    } else {
      toast.dismiss(TOAST_ID);
    }
  };

  const retry = async () => {
    try {
      show(await invoke<McpStatus>("browser_mcp_retry"));
    } catch (error) {
      console.error("could not retry the MCP endpoint", error);
    }
  };

  void (async () => {
    try {
      // Listen before reading: a failure after the read arrives as an event,
      // one before it is in the read.
      const stop = await listen<McpStatus>(STATUS_EVENT, (event) =>
        show(event.payload),
      );
      if (disposed) {
        stop();
        return;
      }
      unlisten = stop;
      show(await invoke<McpStatus>("browser_mcp_status"));
    } catch (error) {
      console.error("could not read the MCP endpoint status", error);
    }
  })();

  return () => {
    disposed = true;
    unlisten?.();
  };
}
