import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path/posix";
import { parseSync } from "oxc-parser";

// TypeScript 7 no longer ships the compiler API this used to parse with, so
// chunks go through oxc, whose ESTree AST names the same three statements.
const STATIC_MODULE_STATEMENTS = new Set([
  "ImportDeclaration",
  "ExportNamedDeclaration",
  "ExportAllDeclaration",
]);

export function staticChunkImports(source) {
  const { program, errors } = parseSync("chunk.js", source, {
    lang: "js",
    sourceType: "module",
  });
  if (errors.length > 0) {
    throw new Error(`a production chunk does not parse: ${errors[0].message}`);
  }
  const imports = [];
  for (const statement of program.body) {
    if (STATIC_MODULE_STATEMENTS.has(statement.type) && statement.source) {
      imports.push(statement.source.value);
    }
  }
  return imports;
}

export function findStaticChunkCycle(sources) {
  const graph = new Map();
  for (const [name, source] of sources) {
    const dependencies = staticChunkImports(source)
      .filter((specifier) => specifier.startsWith("."))
      .map((specifier) => normalize(join(dirname(name), specifier)))
      .filter((dependency) => sources.has(dependency));
    graph.set(name, dependencies);
  }

  const visited = new Set();
  const active = new Map();
  const stack = [];

  function visit(name) {
    if (active.has(name)) {
      return [...stack.slice(active.get(name)), name];
    }
    if (visited.has(name)) return null;

    active.set(name, stack.length);
    stack.push(name);
    for (const dependency of graph.get(name) ?? []) {
      const cycle = visit(dependency);
      if (cycle) return cycle;
    }
    stack.pop();
    active.delete(name);
    visited.add(name);
    return null;
  }

  for (const name of graph.keys()) {
    const cycle = visit(name);
    if (cycle) return cycle;
  }
  return null;
}

export function assertNoStaticChunkCycles(assetsDir) {
  const sources = new Map(
    readdirSync(assetsDir)
      .filter((name) => name.endsWith(".js"))
      .map((name) => [name, readFileSync(join(assetsDir, name), "utf8")]),
  );
  const cycle = findStaticChunkCycle(sources);
  if (cycle) {
    throw new Error(
      `production bundle contains a static chunk cycle: ${cycle.join(" -> ")}`,
    );
  }
}
