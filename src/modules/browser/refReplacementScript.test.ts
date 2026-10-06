import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const replacementSource = readFileSync(
  new URL(
    "../../../src-tauri/src/modules/browser_automation/refReplacement.js",
    import.meta.url,
  ),
  "utf8",
);

type Fake = {
  localName: string;
  type?: string;
  name: string;
  role?: string;
  isConnected: boolean;
  rendered: boolean;
  getAttribute: (name: string) => string | null;
};

function element(
  localName: string,
  name: string,
  options: {
    type?: string;
    role?: string;
    connected?: boolean;
    rendered?: boolean;
  } = {},
): Fake {
  return {
    localName,
    type: options.type,
    name,
    isConnected: options.connected ?? true,
    rendered: options.rendered ?? true,
    getAttribute: (attribute) =>
      attribute === "role" ? (options.role ?? null) : null,
  };
}

function successorOf(old: Fake, live: Fake[]) {
  const context = vm.createContext({
    accessibleName: (node: Fake) => node.name,
    isRenderedElement: (node: Fake) => node.rendered,
    document: {
      querySelectorAll: (tag: string) =>
        live.filter((node) => node.localName === tag),
    },
  });
  vm.runInContext(replacementSource, context);
  context.old = old;
  const found = vm.runInContext("refReplacement(old)", context) as Fake | null;
  return {
    found,
    role: found
      ? vm.runInContext("refRole(refReplacement(old))", context)
      : null,
  };
}

describe("the element that replaced a detached ref", () => {
  const detached = element("input", "Search Wikipedia", {
    type: "search",
    connected: false,
  });

  it("is the one rendered element with the same tag, type and name", () => {
    const next = element("input", "Search Wikipedia", {
      type: "search",
      role: "combobox",
    });
    const other = element("input", "Search help", { type: "search" });
    const { found, role } = successorOf(detached, [other, next]);
    expect(found).toBe(next);
    expect(role).toBe("combobox");
  });

  it("is not named when two could have taken its place", () => {
    const twins = [
      element("input", "Search Wikipedia", { type: "search" }),
      element("input", "Search Wikipedia", { type: "search" }),
    ];
    expect(successorOf(detached, twins).found).toBeNull();
  });

  it("must keep the input type and be rendered", () => {
    expect(
      successorOf(detached, [
        element("input", "Search Wikipedia", { type: "text" }),
        element("input", "Search Wikipedia", {
          type: "search",
          rendered: false,
        }),
      ]).found,
    ).toBeNull();
  });

  it("is never looked for a node without a name or one still in the page", () => {
    const unnamed = element("button", "", { connected: false });
    expect(successorOf(unnamed, [element("button", "")]).found).toBeNull();
    const connected = element("input", "Search Wikipedia", { type: "search" });
    expect(
      successorOf(connected, [
        element("input", "Search Wikipedia", { type: "search" }),
      ]).found,
    ).toBeNull();
  });
});
