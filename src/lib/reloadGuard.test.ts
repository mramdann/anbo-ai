import { describe, expect, it } from "vitest";
import { blockPageReloadKeys, isReloadKey } from "./reloadGuard";

type Pressed = {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  target: { closest: (selector: string) => unknown } | null;
  defaultPrevented: boolean;
  preventDefault: () => void;
};

function pressed(
  key: string,
  held: { ctrl?: boolean; meta?: boolean; alt?: boolean } = {},
  inEditor = false,
): Pressed {
  return {
    key,
    ctrlKey: held.ctrl ?? false,
    metaKey: held.meta ?? false,
    altKey: held.alt ?? false,
    target: {
      closest: (selector) =>
        inEditor && selector === ".cm-editor" ? {} : null,
    },
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
  };
}

function page() {
  const early: ((event: Pressed) => void)[] = [];
  const late: ((event: Pressed) => void)[] = [];
  blockPageReloadKeys({
    addEventListener: (
      _type: string,
      listener: (event: Pressed) => void,
      options?: { capture?: boolean },
    ) => {
      (options?.capture ? early : late).push(listener);
    },
  } as unknown as Window);
  return { early, late };
}

describe("isReloadKey", () => {
  it("names the keys a webview takes for reloading its page", () => {
    expect(isReloadKey(pressed("F5"))).toBe(true);
    expect(isReloadKey(pressed("F5", { ctrl: true }))).toBe(true);
    expect(isReloadKey(pressed("r", { ctrl: true }))).toBe(true);
    expect(isReloadKey(pressed("R", { ctrl: true }))).toBe(true);
    expect(isReloadKey(pressed("r", { meta: true }))).toBe(true);
  });

  it("leaves every other key alone", () => {
    expect(isReloadKey(pressed("r"))).toBe(false);
    expect(isReloadKey(pressed("r", { ctrl: true, alt: true }))).toBe(false);
    expect(isReloadKey(pressed("F4"))).toBe(false);
    expect(isReloadKey(pressed("t", { ctrl: true }))).toBe(false);
  });
});

describe("blockPageReloadKeys", () => {
  it("cancels a reload key on its way down, before a listener can stop it", () => {
    const { early } = page();
    expect(early).toHaveLength(1);
    for (const event of [pressed("F5"), pressed("r", { ctrl: true })]) {
      early[0](event);
      expect(event.defaultPrevented).toBe(true);
    }
    const other = pressed("a");
    early[0](other);
    expect(other.defaultPrevented).toBe(false);
  });

  it("lets the code editor see its own Ctrl+R first, then cancels it", () => {
    const { early, late } = page();
    expect(late).toHaveLength(1);
    const event = pressed("r", { ctrl: true }, true);
    early[0](event);
    expect(event.defaultPrevented).toBe(false);
    late[0](event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("cancels F5 on its way down in the code editor too", () => {
    const { early } = page();
    const event = pressed("F5", {}, true);
    early[0](event);
    expect(event.defaultPrevented).toBe(true);
  });
});
