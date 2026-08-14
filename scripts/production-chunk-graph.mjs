import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path/posix";
import ts from "typescript";

export function staticChunkImports(source) {
  const file = ts.createSourceFile(
    "chunk.js",
    source,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.JS,
  );
  const imports = [];
  for (const statement of file.statements) {
    if (
      (ts.isImportDeclaration(statement) ||
        ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      imports.push(statement.moduleSpecifier.text);
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
