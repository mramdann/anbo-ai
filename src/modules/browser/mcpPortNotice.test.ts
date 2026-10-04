import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: [] as ((event: { payload: unknown }) => void)[],
  toast: { warning: vi.fn(), success: vi.fn(), dismiss: vi.fn() },
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(
    async (_event: string, handler: (event: { payload: unknown }) => void) => {
      mocks.listeners.push(handler);
      return () => {};
    },
  ),
}));
vi.mock("sonner", () => ({ toast: mocks.toast }));

import {
  describeMcpFailure,
  type McpStatus,
  watchMcpPort,
} from "./mcpPortNotice";

const url = "http://127.0.0.1:7331/mcp";
const failed: McpStatus = {
  state: "failed",
  url,
  error: "Only one usage of each socket address is normally permitted.",
  inUse: true,
  holder: { pid: 5688, name: "zeron.exe" },
};
const listening: McpStatus = {
  state: "listening",
  url,
  error: null,
  inUse: false,
  holder: null,
};

describe("MCP port notice", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listeners.length = 0;
  });

  it("names the app that holds the port", () => {
    expect(describeMcpFailure(failed)).toBe(
      "Port 7331 is in use by zeron.exe (PID 5688), so agents cannot reach Anbo's browser. Close it, then retry.",
    );
    expect(describeMcpFailure({ ...failed, holder: null })).toContain(
      "in use by another app",
    );
    expect(
      describeMcpFailure({
        ...failed,
        inUse: false,
        holder: null,
        error: "access denied",
      }),
    ).toBe(
      "Anbo could not open port 7331 for its browser tools (access denied).",
    );
  });

  it("stays silent while the endpoint holds its port", async () => {
    mocks.invoke.mockResolvedValueOnce(listening);
    const stop = watchMcpPort();
    await vi.waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("browser_mcp_status"),
    );
    await Promise.resolve();
    expect(mocks.toast.warning).not.toHaveBeenCalled();
    expect(mocks.toast.success).not.toHaveBeenCalled();
    stop();
  });

  it("keeps warning until a retry gets the port back", async () => {
    mocks.invoke.mockResolvedValueOnce(failed);
    const stop = watchMcpPort();
    await vi.waitFor(() =>
      expect(mocks.toast.warning).toHaveBeenCalledTimes(1),
    );
    const options = mocks.toast.warning.mock.calls[0][1];
    expect(options.duration).toBe(Number.POSITIVE_INFINITY);

    // Still held: the click must not close the warning, which is shown
    // again under the same id.
    const click = { preventDefault: vi.fn() };
    mocks.invoke.mockResolvedValueOnce(failed);
    options.action.onClick(click);
    expect(click.preventDefault).toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(mocks.toast.warning).toHaveBeenCalledTimes(2),
    );
    expect(mocks.toast.warning.mock.calls[1][1].id).toBe(options.id);

    mocks.invoke.mockResolvedValueOnce(listening);
    options.action.onClick({ preventDefault: vi.fn() });
    await vi.waitFor(() =>
      expect(mocks.toast.success).toHaveBeenCalledWith(
        "Browser tools are back",
        // The success replaces the warning in place, so it must not keep the
        // warning's Retry or its endless duration.
        expect.objectContaining({
          id: options.id,
          action: undefined,
          duration: 4_000,
        }),
      ),
    );
    expect(mocks.invoke).toHaveBeenLastCalledWith("browser_mcp_retry");
    stop();
  });

  it("hears a failure that comes after the first read", async () => {
    mocks.invoke.mockResolvedValueOnce({ ...listening, state: "starting" });
    const stop = watchMcpPort();
    await vi.waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("browser_mcp_status"),
    );
    expect(mocks.listeners).toHaveLength(1);
    mocks.listeners[0]({ payload: failed });
    expect(mocks.toast.warning).toHaveBeenCalledTimes(1);
    stop();
  });
});
