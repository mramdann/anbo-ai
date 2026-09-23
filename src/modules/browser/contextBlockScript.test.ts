import { readFileSync } from "node:fs";
import vm from "node:vm";
import { expect, it } from "vitest";

const source = readFileSync(
  new URL(
    "../../../src-tauri/src/modules/browser_automation/contextBlock.js",
    import.meta.url,
  ),
  "utf8",
);
type Element = {
  localName: string;
  parentElement?: Element;
  assignedSlot?: Element;
  getAttribute: (name: string) => string | null;
  getRootNode?: () => { host?: Element };
};
const select = vm.runInNewContext(`${source}; contextBlock`) as (
  element: Element,
  mode: number | "row",
) => Element | null;
const node = (
  localName: string,
  parentElement?: Element,
  role?: string,
): Element => ({ localName, parentElement, getAttribute: () => role ?? null });

it("reads an entire nearest row regardless of wrapper depth", () => {
  const row = node("tr", node("tbody"));
  const leaf = node("a", node("span", node("div", node("td", row))));
  expect(select(leaf, "row")).toBe(row);
  expect(select(leaf, 2)).toBe(leaf.parentElement?.parentElement);
  expect(select(leaf, 0)).toBe(leaf);
});

it("uses the nearest nested ARIA row across slots and shadow hosts", () => {
  const row = node("div", node("tr"), "row");
  const slot = node("slot", row);
  expect(select({ ...node("span"), assignedSlot: slot }, "row")).toBe(row);
  expect(
    select({ ...node("span"), getRootNode: () => ({ host: row }) }, "row"),
  ).toBe(row);
});

it("never substitutes the body or crosses an unbounded ancestry", () => {
  expect(select(node("a", node("body")), "row")).toBeNull();
  let deeplyNested = node("tr");
  for (let i = 0; i < 33; i++) deeplyNested = node("div", deeplyNested);
  expect(select(deeplyNested, "row")).toBeNull();
});
