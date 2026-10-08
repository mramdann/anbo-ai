import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  readText: vi.fn<() => Promise<string>>(),
  writeText: vi.fn<(t: string) => Promise<void>>(),
}));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => native);
const core = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => core);

const web = {
  readText: vi.fn<() => Promise<string>>(),
  writeText: vi.fn<(t: string) => Promise<void>>(),
};

const original = globalThis.navigator;
const LINUX = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15";
const MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";
const WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/155.0.0.0";

function platform(userAgent: string) {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { userAgent, clipboard: web },
  });
}

async function load() {
  vi.resetModules();
  return import("./terminalClipboard");
}

describe("terminalClipboard", () => {
  beforeEach(() => {
    native.readText.mockReset();
    native.writeText.mockReset();
    web.readText.mockReset();
    web.writeText.mockReset();
    core.invoke.mockReset();
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: original,
    });
  });

  it("reads the native clipboard first on Linux", async () => {
    platform(LINUX);
    native.readText.mockResolvedValue("native");
    web.readText.mockResolvedValue("web");
    const { readTerminalClipboard } = await load();
    await expect(readTerminalClipboard()).resolves.toBe("native");
    expect(web.readText).not.toHaveBeenCalled();
  });

  it("falls back to the web clipboard when the native read fails", async () => {
    platform(LINUX);
    native.readText.mockRejectedValue(new Error("no ipc"));
    web.readText.mockResolvedValue("web");
    const { readTerminalClipboard } = await load();
    await expect(readTerminalClipboard()).resolves.toBe("web");
  });

  it("never touches the native clipboard off Linux", async () => {
    platform(MAC);
    web.readText.mockResolvedValue("web");
    const { readTerminalClipboard, writeTerminalClipboard } = await load();
    await expect(readTerminalClipboard()).resolves.toBe("web");
    await writeTerminalClipboard("x");
    expect(native.readText).not.toHaveBeenCalled();
    expect(native.writeText).not.toHaveBeenCalled();
    expect(web.writeText).toHaveBeenCalledWith("x");
  });

  it("reads Windows' clipboard natively, never through the permission prompt", async () => {
    platform(WINDOWS);
    core.invoke
      .mockResolvedValueOnce("native text")
      .mockResolvedValueOnce(null);
    const { readTerminalClipboard } = await load();
    await expect(readTerminalClipboard()).resolves.toBe("native text");
    // No text on the clipboard (an image) reads as null.
    await expect(readTerminalClipboard()).resolves.toBeNull();
    expect(core.invoke).toHaveBeenCalledWith("clipboard_read_text");
    expect(web.readText).not.toHaveBeenCalled();
    core.invoke.mockRejectedValueOnce("another program holds the clipboard");
    await expect(readTerminalClipboard()).rejects.toBe(
      "another program holds the clipboard",
    );
  });

  it("writes the native clipboard first on Linux", async () => {
    platform(LINUX);
    native.writeText.mockResolvedValue();
    const { writeTerminalClipboard } = await load();
    await writeTerminalClipboard("copied");
    expect(native.writeText).toHaveBeenCalledWith("copied");
    expect(web.writeText).not.toHaveBeenCalled();
  });
});
