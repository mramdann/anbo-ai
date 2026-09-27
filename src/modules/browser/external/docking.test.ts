import {
  createDockLayoutOwnership,
  createDockLayoutPublisher,
  type DockLayout,
  dockMutationAffectsLayout,
  orderedLayout,
  panelLayout,
} from "@/modules/browser/external/docking";
import { describe, expect, it, vi } from "vitest";

describe("native dock panel layout", () => {
  it("prevents an old panel's late cleanup from hiding its active replacement", () => {
    const owners = createDockLayoutOwnership();
    const previous = owners.claim("dock-one");
    const current = owners.claim("dock-one");
    expect(previous.current()).toBe(false);
    expect(previous.release()).toBe(false);
    expect(current.current()).toBe(true);
    expect(current.release()).toBe(true);
    expect(current.current()).toBe(false);
    expect(current.release()).toBe(false);
  });

  it("keeps different docks independent and allows reveal after the last owner hides", () => {
    const owners = createDockLayoutOwnership();
    const first = owners.claim("dock-one");
    const other = owners.claim("dock-two");
    expect(first.release()).toBe(true);
    expect(other.current()).toBe(true);
    const revealed = owners.claim("dock-one");
    expect(first.current()).toBe(false);
    expect(first.release()).toBe(false);
    expect(revealed.current()).toBe(true);
    expect(other.release()).toBe(true);
    expect(revealed.release()).toBe(true);
  });

  it("orders an in-flight hide before a newer owner's visible layout", () => {
    const owners = createDockLayoutOwnership();
    const layout = panelLayout(
      { x: 672, y: 141, width: 1247, height: 771 },
      1,
      true,
    );
    const previous = owners.claim("dock-one");
    expect(previous.release()).toBe(true);
    const hidden = orderedLayout({ ...layout, visible: false });
    const current = owners.claim("dock-one");
    const shown = orderedLayout(layout);
    expect(shown.revision).toBeGreaterThan(hidden.revision);
    expect(previous.release()).toBe(false);
    expect(current.current()).toBe(true);
  });

  it("orders workspace changes when scheduled, even within one millisecond or after clock rollback", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(100);
    try {
      const layout = panelLayout(
        { x: 0, y: 0, width: 800, height: 600 },
        1,
        true,
      );
      const first = orderedLayout(layout);
      const hidden = orderedLayout({ ...layout, visible: false });
      clock.mockReturnValue(1);
      const visible = orderedLayout(layout);
      expect(hidden.revision).toBeGreaterThan(first.revision);
      expect(visible.revision).toBeGreaterThan(hidden.revision);
    } finally {
      clock.mockRestore();
    }
  });
  it("converts the panel, not the whole Anbo window, to physical pixels", () => {
    expect(
      panelLayout({ x: 420, y: 90, width: 600, height: 450 }, 1.5, true),
    ).toEqual({ x: 630, y: 135, width: 900, height: 675, visible: true });
  });
  it("hides inactive or undersized panels without changing their tab binding", () => {
    expect(
      panelLayout({ x: 20, y: 40, width: 800, height: 600 }, 1, false).visible,
    ).toBe(false);
    expect(
      panelLayout({ x: 20, y: 40, width: 200, height: 100 }, 1, true).visible,
    ).toBe(false);
  });
  it("rejects invalid or escaping geometry", () => {
    for (const ratio of [NaN, Infinity, 0, 9])
      expect(
        panelLayout({ x: 0, y: 0, width: 800, height: 600 }, ratio, true)
          .visible,
      ).toBe(false);
    expect(
      panelLayout({ x: -1, y: 0, width: 800, height: 600 }, 1, true).visible,
    ).toBe(false);
  });
});

const visibleLayout: DockLayout = {
  x: 672,
  y: 141,
  width: 1247,
  height: 771,
  visible: true,
};

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<Value>((accepted, refused) => {
    resolve = accepted;
    reject = refused;
  });
  return { promise, resolve, reject };
}

describe("native dock layout delivery", () => {
  it("coalesces resize bursts, hides on workspace departure and reveals with the same dock", async () => {
    const owners = createDockLayoutOwnership();
    const pending = deferred<{ dockId: string }>();
    const write = vi.fn().mockImplementationOnce(() => pending.promise);
    write.mockResolvedValue({ dockId: "dock" });
    const settled = vi.fn();
    const failed = vi.fn();
    const publisher = createDockLayoutPublisher(
      owners.claim("dock"),
      write,
      settled,
      failed,
    );
    const flight = publisher.publish(visibleLayout);
    void publisher.publish({ ...visibleLayout, width: 900 });
    void publisher.publish({ ...visibleLayout, width: 800 });
    const stopped = publisher.stop(visibleLayout);
    pending.resolve({ dockId: "dock" });
    await flight;
    await stopped;
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[1][0]).toMatchObject({
      ...visibleLayout,
      visible: false,
    });
    expect(settled).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
    const revealed = createDockLayoutPublisher(
      owners.claim("dock"),
      write,
      settled,
      failed,
    );
    await revealed.publish({ ...visibleLayout, width: 800 });
    expect(write.mock.calls[2][0]).toMatchObject({
      ...visibleLayout,
      width: 800,
    });
    expect(write.mock.calls[2][0].revision).toBeGreaterThan(
      write.mock.calls[1][0].revision,
    );
    expect(settled).toHaveBeenCalledWith({ dockId: "dock" });
    await revealed.stop(visibleLayout);
  });

  it("does not cache a failed delivery and still sends a queued hide after failure", async () => {
    const owners = createDockLayoutOwnership();
    const failure = new Error("IPC unavailable");
    const write = vi
      .fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValue({ dockId: "dock" });
    const failed = vi.fn();
    const publisher = createDockLayoutPublisher(
      owners.claim("dock"),
      write,
      vi.fn(),
      failed,
    );
    await publisher.publish(visibleLayout);
    expect(failed).toHaveBeenCalledWith(failure);
    await publisher.publish(visibleLayout);
    expect(write).toHaveBeenCalledTimes(2);
    const pending = deferred<{ dockId: string }>();
    write.mockImplementationOnce(() => pending.promise);
    const flight = publisher.publish({ ...visibleLayout, width: 800 });
    const stopped = publisher.stop(visibleLayout);
    pending.reject(failure);
    await flight;
    await stopped;
    expect(write).toHaveBeenCalledTimes(4);
    expect(write.mock.calls[3][0].visible).toBe(false);
    expect(failed).toHaveBeenCalledTimes(1);
  });

  it("drops a replaced presenter's queued resize, cleanup and late replies", async () => {
    const owners = createDockLayoutOwnership();
    const pending = deferred<{ dockId: string | null }>();
    const oldWrite = vi.fn(() => pending.promise);
    const settled = vi.fn();
    const failed = vi.fn();
    const previous = createDockLayoutPublisher(
      owners.claim("dock"),
      oldWrite,
      settled,
      failed,
    );
    const flight = previous.publish(visibleLayout);
    void previous.publish({ ...visibleLayout, width: 900 });
    const newWrite = vi.fn().mockResolvedValue({ dockId: "dock" });
    const current = createDockLayoutPublisher(
      owners.claim("dock"),
      newWrite,
      vi.fn(),
      vi.fn(),
    );
    await current.publish({ ...visibleLayout, width: 800 });
    pending.resolve({ dockId: null });
    await flight;
    await previous.stop(visibleLayout);
    await previous.publish(visibleLayout);
    expect(oldWrite).toHaveBeenCalledTimes(1);
    expect(settled).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
    expect(newWrite).toHaveBeenCalledTimes(1);
    await current.stop(visibleLayout);
  });

  it("deduplicates stable layouts without losing an update during promise completion", async () => {
    const owners = createDockLayoutOwnership();
    const write = vi.fn().mockResolvedValue({ dockId: "dock" });
    const publisher = createDockLayoutPublisher(
      owners.claim("dock"),
      write,
      vi.fn(),
      vi.fn(),
    );
    await publisher.publish(visibleLayout);
    const duplicate = publisher.publish(visibleLayout);
    const resized = publisher.publish({ ...visibleLayout, width: 800 });
    await duplicate;
    await resized;
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[1][0].width).toBe(800);
    await publisher.stop(visibleLayout);
    await publisher.stop(visibleLayout);
    expect(write).toHaveBeenCalledTimes(3);
  });

  it("performs no polling, retries or duplicate IPC while an unchanged panel is idle", async () => {
    vi.useFakeTimers();
    try {
      const owners = createDockLayoutOwnership();
      const write = vi.fn().mockResolvedValue({ dockId: "dock" });
      const publisher = createDockLayoutPublisher(
        owners.claim("dock"),
        write,
        vi.fn(),
        vi.fn(),
      );
      await publisher.publish(visibleLayout);
      for (let index = 0; index < 100; index += 1)
        await publisher.publish(visibleLayout);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(write).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      await publisher.stop(visibleLayout);
    } finally {
      vi.useRealTimers();
    }
  });
});

function element(
  options: {
    containsSurface?: boolean;
    overlay?: boolean;
    insideOverlay?: boolean;
    nestedOverlay?: boolean;
    miniWindow?: boolean;
  } = {},
) {
  return {
    nodeType: 1,
    contains: vi.fn(() => options.containsSurface ?? false),
    matches: vi.fn(() => options.overlay ?? false),
    hasAttribute: vi.fn(() => options.miniWindow ?? false),
    closest: vi.fn(() => (options.insideOverlay ? {} : null)),
    querySelector: vi.fn(() => (options.nestedOverlay ? {} : null)),
  } as unknown as HTMLElement;
}

function mutation(
  target: Node,
  options: Partial<MutationRecord> = {},
): MutationRecord {
  return {
    target,
    type: "attributes",
    attributeName: "class",
    addedNodes: [],
    removedNodes: [],
    ...options,
  } as unknown as MutationRecord;
}

describe("native dock mutation filtering", () => {
  it("ignores terminal output and unrelated activity instead of measuring the panel", () => {
    const surface = element();
    const row = element();
    const output = element();
    const records = [
      mutation(row),
      mutation(row),
      mutation(output, { type: "childList" }),
    ];
    expect(dockMutationAffectsLayout(records, surface)).toBe(false);
    expect(row.querySelector).toHaveBeenCalledTimes(1);
  });

  it("detects panel ancestors, overlays, and overlay ancestors", () => {
    for (const target of [
      element({ containsSurface: true }),
      element({ overlay: true }),
      element({ insideOverlay: true }),
      element({ nestedOverlay: true }),
      element({ miniWindow: true }),
    ]) {
      expect(dockMutationAffectsLayout([mutation(target)], element())).toBe(
        true,
      );
    }
  });

  it("detects overlay removal and role removal that must reveal the native window", () => {
    const overlay = element({ overlay: true });
    expect(
      dockMutationAffectsLayout(
        [
          mutation(element(), {
            type: "childList",
            removedNodes: [overlay] as unknown as NodeList,
          }),
        ],
        element(),
      ),
    ).toBe(true);
    expect(
      dockMutationAffectsLayout(
        [mutation(element(), { attributeName: "role" })],
        element(),
      ),
    ).toBe(true);
  });
});
