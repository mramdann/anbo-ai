export function staticChunkImports(source: string): string[];

export function findStaticChunkCycle(
  sources: ReadonlyMap<string, string>,
): string[] | null;

export function assertNoStaticChunkCycles(assetsDir: string): void;
