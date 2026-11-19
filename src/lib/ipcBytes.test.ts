import { beforeEach, describe, expect, it, vi } from "vitest";

const log = vi.hoisted(() => ({ warn: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/plugin-log", () => ({ warn: log.warn }));

describe("ipcBytes", () => {
  beforeEach(() => {
    vi.resetModules();
    log.warn.mockClear();
  });

  it("hands an ArrayBuffer on as it is", async () => {
    const { ipcBytes } = await import("./ipcBytes");
    const buffer = new Uint8Array([1, 2, 3]).buffer;
    expect(ipcBytes(buffer)).toBe(buffer);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("reads the array of numbers Tauri's fallback path delivers", async () => {
    // Measured (round 114): one request of the page made to fail put Tauri's
    // IPC on its postMessage path, and the next terminal output message over
    // 6 KB arrived as number[]. Read as an ArrayBuffer it threw, and the
    // terminal showed "[anbo: 26397 bytes of output were lost]".
    const { ipcBytes } = await import("./ipcBytes");
    const bytes = [0, 9, 0, 0, 0, 0, 0, 0, 0, 0x1b, 0xff, 10];
    const read = ipcBytes(bytes);
    expect(read).toBeInstanceOf(ArrayBuffer);
    expect(Array.from(new Uint8Array(read))).toEqual(bytes);
    expect(Array.from(new Uint8Array(ipcBytes([])))).toEqual([]);
  });

  it("says once in Anbo's log that the window took the fallback path", async () => {
    const { ipcBytes } = await import("./ipcBytes");
    ipcBytes([1]);
    ipcBytes([2]);
    ipcBytes([3]);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(String(log.warn.mock.calls[0])).toContain(
      "fell back to postMessage",
    );
  });

  it("takes only a view's own bytes", async () => {
    const { ipcBytes } = await import("./ipcBytes");
    const view = new Uint8Array([9, 8, 7, 6, 5]).subarray(1, 4);
    expect(Array.from(new Uint8Array(ipcBytes(view)))).toEqual([8, 7, 6]);
  });
});
