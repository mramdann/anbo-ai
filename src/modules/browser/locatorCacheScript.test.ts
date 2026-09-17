import { readFileSync } from "node:fs";
import vm from "node:vm";
import { expect, it, vi } from "vitest";

const source = readFileSync(
  new URL(
    "../../../src-tauri/src/modules/browser_automation/locatorCache.js",
    import.meta.url,
  ),
  "utf8",
);

it("memoizes false and empty values by element identity only within a scan", () => {
  const read = vi.fn((element: { value: unknown }) => element.value);
  const factory = vm.runInNewContext(
    `${source}; memoizeElement`,
  ) as typeof makeReader;
  function makeReader(read: (element: { value: unknown }) => unknown) {
    return read;
  }
  const scan = factory(read),
    element = { value: false as unknown };
  expect(scan(element)).toBe(false);
  element.value = "updated";
  expect(scan(element)).toBe(false);
  expect(read).toHaveBeenCalledTimes(1);
  expect(factory(read)(element)).toBe("updated");
  expect(scan({ value: undefined })).toBeUndefined();
});

it("role candidate filtering retains HTML, explicit and lowercase SVG roles", () => {
  const rust = readFileSync(
    new URL(
      "../../../src-tauri/src/modules/browser_automation/locator.rs",
      import.meta.url,
    ),
    "utf8",
  );
  const roleSource = rust
    .slice(
      rust.indexOf("const roleTags ="),
      rust.indexOf("// A search field is a textbox"),
    )
    .replace(/\{\{/g, "{")
    .replace(/\}\}/g, "}");
  const role = vm.runInNewContext(`${roleSource}; implicitRole`, {
    normalize: (value: unknown) => String(value ?? "").trim(),
  }) as (el: unknown) => string;
  const element = (
    tagName: string,
    namespaceURI = "http://www.w3.org/1999/xhtml",
    explicit: string | null = null,
  ) => ({
    tagName,
    namespaceURI,
    getAttribute: () => explicit,
    hasAttribute: () => true,
  });
  expect(role(element("SPAN"))).toBe("");
  expect(role(element("BUTTON"))).toBe("button");
  expect(role(element("SPAN", undefined, "switch"))).toBe("switch");
  expect(role(element("a", "http://www.w3.org/2000/svg"))).toBe("link");
});
