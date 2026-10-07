import {
  type AutoDockState,
  createDockHolders,
  createDockLayoutOwnership,
  createDockLayoutPublisher,
  type DockLayout,
  type DockStatus,
  dockMutationAffectsLayout,
  orderedLayout,
  panelLayout,
  shouldAttachDock,
} from "@/modules/browser/external/docking";
import { describe, expect, it, vi } from "vitest";

describe("automatic docking", () => {
  const ready: AutoDockState = {
    visible: true,
    connected: true,
    focused: true,
    presented: true,
    checked: true,
    docked: false,
    busy: false,
    held: false,
    elsewhere: false,
  };

  it("docks a shown, connected tab by itself", () => {
    expect(shouldAttachDock(ready)).toBe(true);
  });

  it.each([
    ["hidden", { visible: false }],
    ["disconnected", { connected: false }],
    // A dock window opened while another app is in front would flash over it.
    ["Anbo not in front", { focused: false }],
    ["minimized or covered", { presented: false }],
    ["status unknown", { checked: false }],
    ["already docked", { docked: true }],
    ["attaching", { busy: true }],
    ["held after a failure or a move", { held: true }],
    // The page would jump to a panel that appears beside the one showing it.
    ["another tab's shown panel holds the page", { elsewhere: true }],
  ] as const)("waits when %s", (_name, change) => {
    expect(shouldAttachDock({ ...ready, ...change })).toBe(false);
  });
});

describe("dock holders", () => {
  const pane = (tabId: number, shown: boolean) => ({
    tabId,
    shown,
    release: async () => {},
  });

  it("counts only another tab's shown pane as holding the page", () => {
    const holders = createDockHolders();
    holders.add(pane(7, true));
    expect(holders.heldElsewhere(7)).toBe(false);
    const hidden = holders.add(pane(8, false));
    expect(holders.heldElsewhere(7)).toBe(false);
    hidden();
    holders.add(pane(8, true));
    expect(holders.heldElsewhere(7)).toBe(true);
  });

  it("keeps a tab holding the dock until its last pane goes", () => {
    // A tab hidden in its panel also has a pane in the background host, which
    // goes when the tab shows again while the panel's pane still holds.
    const holders = createDockHolders();
    const shown = pane(8, true);
    holders.add(shown);
    const background = holders.add(pane(8, false));
    background();
    expect(holders.others(7)).toEqual([shown]);
    expect(holders.others(7)[0]).toBe(shown);
    expect(holders.heldElsewhere(7)).toBe(true);
  });

  it("gives each other tab's dock up once", () => {
    const holders = createDockHolders();
    const first = pane(8, false);
    holders.add(first);
    holders.add(pane(8, true));
    holders.add(pane(7, true));
    expect(holders.others(7)).toHaveLength(1);
    expect(holders.others(7)[0]).toBe(first);
    expect(holders.others(8)).toHaveLength(1);
  });

  it("tells subscribers when a pane comes or goes, once each", () => {
    const holders = createDockHolders();
    const changed = vi.fn();
    const unsubscribe = holders.subscribe(changed);
    const remove = holders.add(pane(8, true));
    remove();
    remove();
    expect(changed).toHaveBeenCalledTimes(2);
    unsubscribe();
    holders.add(pane(9, true));
    expect(changed).toHaveBeenCalledTimes(2);
  });
});

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
    ).toEqual({
      x: 630,
      y: 135,
      width: 900,
      height: 675,
      visible: true,
      covered: false,
      cutouts: [],
    });
  });
  it("hides inactive panels and leaves the minimum size to the browser", () => {
    expect(
      panelLayout({ x: 20, y: 40, width: 800, height: 600 }, 1, false).visible,
    ).toBe(false);
    expect(
      panelLayout({ x: 20, y: 40, width: 200, height: 100 }, 1, true).visible,
    ).toBe(true);
  });
  it("hands Anbo menus the input and keeps floating panels above the page", () => {
    const layout = panelLayout(
      { x: 100, y: 50, width: 800, height: 600 },
      1.25,
      true,
      true,
      [
        { x: 700, y: 500, width: 400, height: 300 },
        { x: 0, y: 0, width: 50, height: 50 },
      ],
    );
    expect(layout.covered).toBe(true);
    expect(layout.cutouts).toEqual([
      { x: 875, y: 625, width: 250, height: 188 },
    ]);
    const many = panelLayout(
      { x: 0, y: 0, width: 800, height: 600 },
      1,
      true,
      false,
      Array.from({ length: 20 }, (_, index) => ({
        x: index * 10,
        y: 0,
        width: 5,
        height: 5,
      })),
    );
    // Four toasts with their close buttons, the mini window and the voice orb.
    expect(many.cutouts).toHaveLength(16);
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
  covered: false,
  cutouts: [],
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
    const pending = deferred<DockStatus>();
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
    pending.resolve({ dockId: null, live: false, reason: null });
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
