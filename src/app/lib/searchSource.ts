import type { EditorPaneHandle } from "@/modules/editor";
import type { GitHistorySearchHandle } from "@/modules/git-history";
import type { SearchSource } from "@/modules/header";
import type { TerminalPaneHandle } from "@/modules/terminal";
import type { SearchAddon } from "@xterm/addon-search";

type MapRef<T> = { readonly current: ReadonlyMap<number, T> };

const objectKeys = new WeakMap<object, number>();
let lastObjectKey = 0;

/** The same number each time for the same object. App's state names the shown
 *  tab's search object by it and leaves the object in a ref map: an object
 *  held in App's render scope outlived its pane (round 88, R87-2). */
export function searchObjectKey(
  object: object | null | undefined,
): number | null {
  if (!object) return null;
  let key = objectKeys.get(object);
  if (key === undefined) {
    key = ++lastObjectKey;
    objectKeys.set(object, key);
  }
  return key;
}

/** Reads App's ref maps when the header search uses them. Made once and
 *  outside App's render, so it keeps the maps alive and nothing else. */
export function createSearchSource(maps: {
  searchAddons: MapRef<SearchAddon>;
  terminals: MapRef<TerminalPaneHandle>;
  editors: MapRef<EditorPaneHandle>;
  gitHistory: MapRef<GitHistorySearchHandle>;
}): SearchSource {
  return {
    terminal: (leafId) => maps.searchAddons.current.get(leafId),
    editor: (tabId) => maps.editors.current.get(tabId),
    gitHistory: (tabId) => maps.gitHistory.current.get(tabId),
    focus: (target) => {
      if (target.kind === "terminal") {
        maps.terminals.current.get(target.leafId)?.focus();
      } else if (target.kind === "editor") {
        maps.editors.current.get(target.tabId)?.focus();
      }
    },
  };
}

/** What a git history pane hands its search handle to. App keeps one per tab,
 *  and one made inside App's render kept that render alive, with every older
 *  render its memoized callbacks reach (round 88, R87-2). */
export function gitHistoryHandleCallback(
  tabId: number,
  handles: Map<number, GitHistorySearchHandle>,
  activeId: { readonly current: number },
  setActiveKey: (key: number | null) => void,
): (handle: GitHistorySearchHandle | null) => void {
  return (handle) => {
    if (handle) handles.set(tabId, handle);
    else handles.delete(tabId);
    if (activeId.current === tabId) setActiveKey(searchObjectKey(handle));
  };
}
