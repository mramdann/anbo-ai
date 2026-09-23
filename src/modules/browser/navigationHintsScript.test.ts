import { readFileSync } from "node:fs";
import vm from "node:vm";
import { expect, it } from "vitest";

const read = (file: string) =>
  readFileSync(
    new URL(
      `../../../src-tauri/src/modules/browser_automation/${file}`,
      import.meta.url,
    ),
    "utf8",
  );
const rust = read("actions.rs").split("fn build_navigation_hints_js(")[1];
const template = rust
  .slice(rust.indexOf('r#"') + 3, rust.indexOf('"#,'))
  .replace(/\{\{/g, "{")
  .replace(/\}\}/g, "}");
const script = template
  .replace("{REF_REGISTRY_JS}", read("refRegistry.js"))
  .replace(/\{generation\}/g, "7")
  .replace("{ref_prefix}", '"g7-e"');
const withQuery = (words: string[], require: boolean) =>
  script
    .replace("{query_words}", JSON.stringify(words))
    .replace("{gate}", JSON.stringify(require ? "results" : "any"));
const plain = withQuery([], false);

function fixture() {
  const document = {
    body: {},
    readyState: "complete",
    querySelector: () => null,
    querySelectorAll: () => [link],
  };
  const attributes = new Map<string, string>([["href", "/target"]]);
  const link = {
    tagName: "A",
    localName: "a",
    baseURI: "https://fixture.test/",
    ownerDocument: document,
    isConnected: true,
    textContent: "Result",
    getAttribute: (name: string) => attributes.get(name) ?? null,
    setAttribute: (name: string, value: string) => attributes.set(name, value),
    removeAttribute: (name: string) => attributes.delete(name),
    closest: () => null,
    querySelector: () => null,
    getBoundingClientRect: () => ({
      width: 100,
      height: 20,
      top: 10,
      bottom: 30,
    }),
  };
  const context = vm.createContext({
    document,
    link,
    URL,
    innerHeight: 800,
  });
  return { document, link, context };
}

it("every emitted navigation hint resolves to the original node", () => {
  const { context, link } = fixture();
  const result = JSON.parse(vm.runInContext(plain, context));
  expect(result.controls).toEqual([
    { ref: "g7-e1", role: "link", name: "Result" },
  ]);
  expect(
    vm.runInContext("globalThis.__anboBrowserRefs.resolve('g7-e1')", context),
  ).toBe(link);
  link.isConnected = false;
  expect(
    vm.runInContext("globalThis.__anboBrowserRefs.resolve('g7-e1')", context),
  ).toBeNull();
});

it("does not publish loading-document controls", () => {
  const { context, document } = fixture();
  document.readyState = "loading";
  expect(vm.runInContext(plain, context)).toBeNull();
  expect(
    vm.runInContext("globalThis.__anboBrowserRefs.resolve('g7-e1')", context),
  ).toBeNull();
});

it("reads the visible h1 and hands back result titles as refs", () => {
  const node = (init: Record<string, unknown>) => {
    const attributes = new Map<string, string>(
      Object.entries((init.attributes as Record<string, string>) ?? {}),
    );
    return {
      baseURI: "https://fixture.test/",
      isConnected: true,
      getAttribute: (name: string) => attributes.get(name) ?? null,
      setAttribute: (name: string, value: string) =>
        attributes.set(name, value),
      removeAttribute: (name: string) => attributes.delete(name),
      querySelector: () => null,
      closest: () => null,
      getBoundingClientRect: () => ({
        width: 300,
        height: 24,
        top: 120,
        bottom: 144,
      }),
      ...init,
    };
  };
  // Amazon: a screen-reader-only h1 first, then the product title.
  const hiddenH1 = node({
    tagName: "H1",
    localName: "h1",
    innerText: "Product summary presents key product information",
    getBoundingClientRect: () => ({ width: 1, height: 1, top: 0, bottom: 1 }),
  });
  const titleH1 = node({
    tagName: "H1",
    localName: "h1",
    innerText: "UGREEN USB C Hub 5 in 1\nVisit the UGREEN Store",
  });
  const result = node({
    tagName: "A",
    localName: "a",
    href: "https://fixture.test/dp/1",
    innerText: "UGREEN USB C Hub 5 in 1",
    attributes: { href: "/dp/1" },
    closest: (selector: string) => (selector === "h2,h3,h4" ? {} : null),
  });
  const document = {
    body: {},
    readyState: "complete",
    querySelector: () => null,
    querySelectorAll: (selector: string) =>
      selector === "h1"
        ? [hiddenH1, titleH1]
        : selector === "a[href]"
          ? [result]
          : [],
  };
  Object.assign(result, { ownerDocument: document });
  const context = vm.createContext({ document, URL, innerHeight: 800 });
  const hints = JSON.parse(vm.runInContext(plain, context));
  expect(hints.heading).toBe("UGREEN USB C Hub 5 in 1");
  expect(hints.results).toEqual([
    { ref: "g7-e1", name: "UGREEN USB C Hub 5 in 1" },
  ]);
  expect(
    vm.runInContext("globalThis.__anboBrowserRefs.resolve('g7-e1')", context),
  ).toBe(result);
});

it("keeps only results naming the search and registers nothing while none do", () => {
  const link = (name: string, href: string) => {
    const attributes = new Map<string, string>([["href", href]]);
    return {
      tagName: "A",
      localName: "a",
      href: `https://fixture.test${href}`,
      baseURI: "https://fixture.test/",
      isConnected: true,
      innerText: name,
      getAttribute: (key: string) => attributes.get(key) ?? null,
      setAttribute: (key: string, value: string) => attributes.set(key, value),
      removeAttribute: (key: string) => attributes.delete(key),
      querySelector: () => null,
      closest: (selector: string) => (selector === "h2,h3,h4" ? {} : null),
      getBoundingClientRect: () => ({
        width: 300,
        height: 24,
        top: 120,
        bottom: 144,
      }),
    };
  };
  // YouTube keeps its home feed on screen for a moment after the search URL moves.
  const home = link("Yo-Yo Ma - Bach: Cello Suite No. 1", "/watch?v=home");
  const result = link(
    "lofi hip hop radio - beats to relax/study to",
    "/watch?v=lofi",
  );
  let links = [home];
  const document = {
    body: {},
    readyState: "complete",
    querySelector: () => null,
    querySelectorAll: (selector: string) =>
      selector === "a[href]" ? links : [],
  };
  for (const item of [home, result])
    Object.assign(item, { ownerDocument: document });
  const context = vm.createContext({ document, URL, innerHeight: 800 });
  const words = ["lofi", "hip", "hop", "radio"];

  expect(vm.runInContext(withQuery(words, true), context)).toBeNull();
  expect(
    vm.runInContext("globalThis.__anboBrowserRefs.resolve('g7-e1')", context),
  ).toBeNull();

  links = [home, result];
  const hints = JSON.parse(vm.runInContext(withQuery(words, true), context));
  expect(hints.results).toEqual([
    { ref: "g7-e1", name: "lofi hip hop radio - beats to relax/study to" },
  ]);
});

it("skips titles that were on screen before the search", () => {
  const link = (name: string, href: string) => {
    const attributes = new Map<string, string>([["href", href]]);
    return {
      tagName: "A",
      localName: "a",
      href: `https://fixture.test${href}`,
      baseURI: "https://fixture.test/",
      isConnected: true,
      innerText: name,
      getAttribute: (key: string) => attributes.get(key) ?? null,
      setAttribute: (key: string, value: string) => attributes.set(key, value),
      removeAttribute: (key: string) => attributes.delete(key),
      querySelector: () => null,
      closest: (selector: string) => (selector === "h2,h3,h4" ? {} : null),
      getBoundingClientRect: () => ({
        width: 300,
        height: 24,
        top: 120,
        bottom: 144,
      }),
    };
  };
  // A lofi-trained home feed names the query as well as the real results do.
  const home = link("90's Chill Lofi Coffee Mix", "/watch?v=home");
  const result = link(
    "lofi hip hop radio - beats to relax/study to",
    "/watch?v=lofi",
  );
  const document = {
    body: {},
    readyState: "complete",
    querySelector: () => null,
    querySelectorAll: (selector: string) =>
      selector === "a[href]" ? [home, result] : [],
  };
  for (const item of [home, result])
    Object.assign(item, { ownerDocument: document });
  const context = vm.createContext({ document, URL, innerHeight: 800 });
  const words = ["lofi", "hip", "hop", "radio"];
  vm.runInContext(
    "globalThis.__anboBeforeSubmit = new WeakMap([[home, home.href]])",
    Object.assign(context, { home }),
  );
  const names = () =>
    JSON.parse(vm.runInContext(withQuery(words, true), context)).results.map(
      (r: { name: string }) => r.name,
    );
  expect(names()).toEqual(["lofi hip hop radio - beats to relax/study to"]);

  // A title element the page reuses for a new result counts again.
  home.href = "https://fixture.test/watch?v=new";
  home.innerText = "lofi girl - synthwave radio";
  expect(names()).toContain("lofi girl - synthwave radio");
});

it("waits for a drawn h1 after a route change and registers nothing meanwhile", () => {
  const attributes = new Map<string, string>();
  const h1 = {
    tagName: "H1",
    localName: "h1",
    baseURI: "https://fixture.test/",
    isConnected: true,
    innerText: "lofi hip hop radio - beats to relax/study to",
    getAttribute: (key: string) => attributes.get(key) ?? null,
    setAttribute: (key: string, value: string) => attributes.set(key, value),
    removeAttribute: (key: string) => attributes.delete(key),
    querySelector: () => null,
    closest: () => null,
    getBoundingClientRect: () => ({
      width: 600,
      height: 28,
      top: 500,
      bottom: 528,
    }),
  };
  let h1s: (typeof h1)[] = [];
  // YouTube's watch page answers with no h1 and only the site name, which its
  // og:title has carried since the first load.
  const document = {
    body: {},
    readyState: "complete",
    title: "YouTube",
    querySelector: (selector: string) =>
      selector === 'meta[property="og:title"]' ? { content: "YouTube" } : null,
    querySelectorAll: (selector: string) => (selector === "h1" ? h1s : []),
  };
  Object.assign(h1, { ownerDocument: document });
  const context = vm.createContext({ document, URL, innerHeight: 800 });
  const heading = script
    .replace("{query_words}", "[]")
    .replace("{gate}", JSON.stringify("heading"));

  expect(vm.runInContext(heading, context)).toBeNull();
  expect(JSON.parse(vm.runInContext(plain, context)).heading).toBe("YouTube");

  // Retitled before its h1 is drawn: the new title is the heading.
  document.title = "lofi hip hop radio - beats to relax/study to - YouTube";
  expect(JSON.parse(vm.runInContext(heading, context)).heading).toBe(
    "lofi hip hop radio - beats to relax/study to - YouTube",
  );

  document.title = "YouTube";
  h1s = [h1];
  expect(JSON.parse(vm.runInContext(heading, context)).heading).toBe(
    "lofi hip hop radio - beats to relax/study to",
  );
});

it("accepts a place heading drawn since the search even when it does not name the query", () => {
  const attributes = new Map<string, string>();
  const h1 = {
    tagName: "H1",
    localName: "h1",
    baseURI: "https://fixture.test/",
    isConnected: true,
    innerText: "Monumen Nasional",
    getAttribute: (key: string) => attributes.get(key) ?? null,
    setAttribute: (key: string, value: string) => attributes.set(key, value),
    removeAttribute: (key: string) => attributes.delete(key),
    querySelector: () => null,
    closest: () => null,
    getBoundingClientRect: () => ({
      width: 300,
      height: 28,
      top: 80,
      bottom: 108,
    }),
  };
  const document = {
    body: {},
    readyState: "complete",
    title: "Monumen Nasional - Google Maps",
    querySelector: () => null,
    querySelectorAll: (selector: string) => (selector === "h1" ? [h1] : []),
  };
  Object.assign(h1, { ownerDocument: document });
  const context = vm.createContext({ document, URL, innerHeight: 800 });
  const search = withQuery(["monas", "jakarta"], true);

  // The same h1 as before the submit is not an answer.
  vm.runInContext(
    "globalThis.__anboBeforeSubmitHeading = 'Monumen Nasional'",
    context,
  );
  expect(vm.runInContext(search, context)).toBeNull();

  vm.runInContext("globalThis.__anboBeforeSubmitHeading = ''", context);
  expect(JSON.parse(vm.runInContext(search, context)).heading).toBe(
    "Monumen Nasional",
  );
});
