import { describe, expect, it } from "vitest";
import {
  type BufferCandidate,
  chooseTerminalBuffer,
  LIVE_BUFFER_LIMIT,
} from "./rendererCapacity";

const busy = (leafId: number): BufferCandidate => ({
  leafId,
  retainedLeafId: null,
  protected: true,
  visible: false,
  lastUsedAt: leafId,
});

describe("terminal buffer admission", () => {
  it("keeps six live TUIs intact instead of evicting the first at five", () => {
    const buffers = Array.from({ length: 5 }, (_, i) => busy(i + 1));
    expect(chooseTerminalBuffer(buffers, 6)).toBe("create");
    buffers.push(busy(6));
    for (let i = 1; i <= 6; i++)
      expect(chooseTerminalBuffer(buffers, i)).toBe(i - 1);
  });

  it("protects a retained parser with pending writes or an active TUI", () => {
    const buffers = Array.from({ length: 5 }, (_, i) => ({
      ...busy(i + 1),
      leafId: null,
      retainedLeafId: i + 1,
    }));
    expect(chooseTerminalBuffer(buffers, 6)).toBe("create");
    expect(chooseTerminalBuffer(buffers, 1)).toBe(0);
  });

  it("reuses the oldest safe hidden buffer before expanding", () => {
    const buffers = Array.from({ length: 6 }, (_, i) => busy(i + 1));
    buffers[4].protected = false;
    buffers[5].protected = false;
    expect(chooseTerminalBuffer(buffers, 7)).toBe(4);
    buffers[4].visible = true;
    expect(chooseTerminalBuffer(buffers, 7)).toBe(5);
  });

  it("refuses at the hard bound without corrupting any live buffer", () => {
    const buffers = Array.from({ length: LIVE_BUFFER_LIMIT }, (_, i) =>
      busy(i + 1),
    );
    expect(chooseTerminalBuffer(buffers, 99)).toBe("full");
    expect(chooseTerminalBuffer(buffers, 1)).toBe(0);
    buffers[3].protected = false;
    expect(chooseTerminalBuffer(buffers, 99)).toBe(3);
  });

  it("does not steal another visible pane even when idle", () => {
    const buffers = Array.from({ length: LIVE_BUFFER_LIMIT }, (_, i) => ({
      ...busy(i + 1),
      protected: false,
      visible: true,
    }));
    expect(chooseTerminalBuffer(buffers, 99)).toBe("full");
  });

  it("keeps a small warm cache and reuses genuinely empty buffers", () => {
    expect(chooseTerminalBuffer([], 1)).toBe("create");
    expect(
      chooseTerminalBuffer([{ ...busy(1), leafId: null, protected: false }], 2),
    ).toBe(0);
    expect(chooseTerminalBuffer([{ ...busy(1), leafId: null }], 2)).toBe(
      "create",
    );
  });
});
