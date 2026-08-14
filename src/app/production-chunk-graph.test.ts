import { describe, expect, it } from "vitest";
import {
  findStaticChunkCycle,
  staticChunkImports,
} from "../../scripts/production-chunk-graph.mjs";

describe("production chunk graph", () => {
  it("extracts static imports and re-exports without dynamic imports", () => {
    const source = [
      'import{a}from"./alpha.js";',
      'import"./side-effect.js";',
      'export{b}from"./beta.js";',
      'const lazy=import("./lazy.js");',
    ].join("");

    expect(staticChunkImports(source)).toEqual([
      "./alpha.js",
      "./side-effect.js",
      "./beta.js",
    ]);
  });

  it("reports a static cycle with its complete path", () => {
    const sources = new Map([
      ["entry.js", 'import"./alpha.js"'],
      ["alpha.js", 'import{b}from"./beta.js"'],
      ["beta.js", 'export{a}from"./alpha.js"'],
    ]);

    expect(findStaticChunkCycle(sources)).toEqual([
      "alpha.js",
      "beta.js",
      "alpha.js",
    ]);
  });

  it("accepts an acyclic static graph", () => {
    const sources = new Map([
      ["entry.js", 'import"./feature.js"'],
      ["feature.js", 'const lazy=import("./entry.js")'],
    ]);

    expect(findStaticChunkCycle(sources)).toBeNull();
  });
});
