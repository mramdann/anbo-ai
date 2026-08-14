import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path/posix";

const STATIC_IMPORT_RE =
  /\b(?:import|export)\s*(?:[^"']*?\bfrom\s*)?["']([^"']+)["']/g;

export function staticChunkImports(source) {
  return [...source.matchAll(STATIC_IMPORT_RE)].map((match) => match[1]);
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
