export type RuntimeIdAllocator = { current: number };

type RuntimeIdScope = {
  __anboTabRuntimeIds?: RuntimeIdAllocator;
};

/**
 * Where the next id outlives a reload of the page. Session storage lasts as
 * long as the webview, so a reloaded page goes on from the last page's ids
 * instead of starting over at 1: after a reload in the round 60 soak, tab,
 * terminal and agent ids that agents still held named other tabs. Unlike
 * local storage it is not shared with the other windows.
 */
type IdStore = Pick<Storage, "getItem" | "setItem">;
const STORE_KEY = "anbo:tabRuntimeIds";

function sessionStore(): IdStore | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

function storedNext(store: IdStore | null): number {
  try {
    const next = Number(store?.getItem(STORE_KEY));
    return Number.isSafeInteger(next) && next > 1 ? next : 1;
  } catch {
    return 1;
  }
}

/** A counter that keeps every move in `store`. */
function keptAllocator(store: IdStore | null): RuntimeIdAllocator {
  let next = storedNext(store);
  return {
    get current() {
      return next;
    },
    set current(value: number) {
      next = value;
      try {
        store?.setItem(STORE_KEY, String(value));
      } catch {
        // Storage refused: ids still never repeat within this page.
      }
    },
  };
}

export function runtimeTabIdAllocator(
  scope: RuntimeIdScope = globalThis as RuntimeIdScope,
  store: IdStore | null = sessionStore(),
): RuntimeIdAllocator {
  scope.__anboTabRuntimeIds ??= keptAllocator(store);
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
