export type RuntimeIdAllocator = { current: number };

type RuntimeIdScope = {
  __anboTabRuntimeIds?: RuntimeIdAllocator;
};

export function runtimeTabIdAllocator(
  scope: RuntimeIdScope = globalThis as RuntimeIdScope,
): RuntimeIdAllocator {
  scope.__anboTabRuntimeIds ??= { current: 1 };
  return scope.__anboTabRuntimeIds;
}

export function takeRuntimeId(allocator: RuntimeIdAllocator): number {
  return allocator.current++;
}

export function reserveRuntimeIds(
  allocator: RuntimeIdAllocator,
  ids: Iterable<number>,
): void {
  for (const id of ids) {
    if (Number.isSafeInteger(id) && id >= allocator.current) {
      allocator.current = id + 1;
    }
  }
}
