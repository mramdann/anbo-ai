import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

const script = (name: string) =>
  readFileSync(
    new URL(
      `../../../src-tauri/src/modules/browser_automation/${name}.js`,
      import.meta.url,
    ),
    "utf8",
  );

function probe(
  options: {
    stale?: boolean;
    hidden?: boolean;
    disabled?: boolean;
    ariaDisabled?: boolean;
    covered?: boolean;
    left?: number;
    pointX?: number;
  } = {},
) {
  const element = {
    disabled: options.disabled,
    getAttribute: () => (options.ariaDisabled ? "true" : null),
    getClientRects: () => [
      { left: options.left ?? 20, top: 20, width: 40, height: 20 },
    ],
    scrollIntoView: vi.fn(),
  };
  const result = vm.runInNewContext(
    `(() => { ${script("actionRect")} ${script("pointerGuard")} })()`,
    {
      el: options.stale ? null : element,
      refId: "g1-e1",
      refRegistry: { reason: () => "context_changed" },
      x: options.pointX ?? 40,
      y: 30,
      innerWidth: 600,
      innerHeight: 500,
      isRenderedElement: () => !options.hidden,
      document: {
        elementFromPoint: () =>
          options.covered ? {} : { parentNode: element },
      },
    },
  );
  expect(element.scrollIntoView).not.toHaveBeenCalled();
  return result;
}

describe("native pointer pre-press guard", () => {
  it("prepares background frame focus before running focus handlers and guards", () => {
    const actions = readFileSync(
      new URL(
        "../../../src-tauri/src/modules/browser_automation/actions.rs",
        import.meta.url,
      ),
      "utf8",
    );
    const frameClick = actions.slice(
      actions.indexOf("async fn dom_click_ref("),
      actions.indexOf("async fn wait_for_checked_state("),
    );
    expect(frameClick).toContain("Emulation.setFocusEmulationEnabled");
    expect(
      frameClick.indexOf("Emulation.setFocusEmulationEnabled"),
    ).toBeLessThan(frameClick.indexOf("el.focus("));
    expect(frameClick.indexOf("refRegistry.resolve(refId)")).toBeLessThan(
      frameClick.indexOf("el.click()"),
    );
  });
  it("allows the same visible enabled target and hit point", () => {
    expect(probe()).toEqual({ ok: true });
  });
  it("retains the identity failure reason", () => {
    expect(probe({ stale: true })).toEqual({
      ok: false,
      error: "stale_ref",
      reason: "context_changed",
    });
  });
  it("rejects movement after pointer positioning", () => {
    expect(probe({ left: 80 })).toEqual({ ok: false, reason: "moved" });
  });
  it("allows subpixel rounding within the preflight stability tolerance", () => {
    expect(probe({ left: 20.4 })).toEqual({ ok: true });
  });
  it("rejects a new overlay without sending a click through it", () => {
    expect(probe({ covered: true })).toEqual({ ok: false, reason: "covered" });
  });
  it("rejects offscreen geometry", () => {
    expect(probe({ left: 700 })).toEqual({ ok: false, reason: "moved" });
  });
  it("rejects invalid geometry", () => {
    expect(probe({ left: Number.NaN })).toEqual({ ok: false, reason: "moved" });
  });
  it("rejects an invalid dispatched point", () => {
    expect(probe({ pointX: Number.NaN })).toEqual({
      ok: false,
      reason: "moved",
    });
  });
  it("rejects a target hidden during pointer movement", () => {
    expect(probe({ hidden: true })).toEqual({ ok: false, reason: "hidden" });
  });
  it.each([{ disabled: true }, { ariaDisabled: true }])(
    "rejects disabled controls: %j",
    (options) => {
      expect(probe(options)).toEqual({ ok: false, reason: "disabled" });
    },
  );
});
