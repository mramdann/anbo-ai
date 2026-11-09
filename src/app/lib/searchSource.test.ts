import type { EditorPaneHandle } from "@/modules/editor";
import type { GitHistorySearchHandle } from "@/modules/git-history";
import type { TerminalPaneHandle } from "@/modules/terminal";
import type { SearchAddon } from "@xterm/addon-search";
import { describe, expect, it, vi } from "vitest";
import {
  createSearchSource,
  gitHistoryHandleCallback,
  searchObjectKey,
} from "./searchSource";

function maps() {
  return {
    searchAddons: { current: new Map<number, SearchAddon>() },
    terminals: { current: new Map<number, TerminalPaneHandle>() },
    editors: { current: new Map<number, EditorPaneHandle>() },
    gitHistory: { current: new Map<number, GitHistorySearchHandle>() },
  };
}

describe("searchObjectKey", () => {
  it("gives an object the same key every time and another object a new one", () => {
    const first = {};
    const second = {};
    const key = searchObjectKey(first);

    expect(key).not.toBeNull();
    expect(searchObjectKey(first)).toBe(key);
    expect(searchObjectKey(second)).not.toBe(key);
    expect(searchObjectKey(null)).toBeNull();
    expect(searchObjectKey(undefined)).toBeNull();
  });
});

describe("createSearchSource", () => {
  it("looks objects up when it is used, so a replaced or removed one is not returned", () => {
    const refs = maps();
    const source = createSearchSource(refs);
    const first = {} as SearchAddon;
    const second = {} as SearchAddon;

    expect(source.terminal(4)).toBeUndefined();
    refs.searchAddons.current.set(4, first);
    expect(source.terminal(4)).toBe(first);
    refs.searchAddons.current.set(4, second);
    expect(source.terminal(4)).toBe(second);
    refs.searchAddons.current.delete(4);
    expect(source.terminal(4)).toBeUndefined();

    const editor = { focus: vi.fn() } as unknown as EditorPaneHandle;
    refs.editors.current.set(7, editor);
    expect(source.editor(7)).toBe(editor);
    const history = { setQuery: vi.fn(), clearQuery: vi.fn() };
    refs.gitHistory.current.set(9, history);
    expect(source.gitHistory(9)).toBe(history);
  });

  it("focuses the target's own terminal or editor", () => {
    const refs = maps();
    const source = createSearchSource(refs);
    const terminalFocus = vi.fn();
    const editorFocus = vi.fn();
    refs.terminals.current.set(4, {
      focus: terminalFocus,
    } as unknown as TerminalPaneHandle);
    refs.editors.current.set(7, {
      focus: editorFocus,
    } as unknown as EditorPaneHandle);

    source.focus({ kind: "terminal", leafId: 4, objectKey: 1 });
    source.focus({ kind: "editor", tabId: 7, objectKey: 2 });
    source.focus({ kind: "git-history", tabId: 9, objectKey: 3 });
    source.focus({ kind: "terminal", leafId: 5, objectKey: 4 });

    expect(terminalFocus).toHaveBeenCalledTimes(1);
    expect(editorFocus).toHaveBeenCalledTimes(1);
  });
});

describe("gitHistoryHandleCallback", () => {
  it("keeps the tab's handle and names it only while that tab is the active one", () => {
    const handles = new Map<number, GitHistorySearchHandle>();
    const activeId = { current: 3 };
    const setActiveKey = vi.fn();
    const callback = gitHistoryHandleCallback(
      5,
      handles,
      activeId,
      setActiveKey,
    );
    const handle = { setQuery: vi.fn(), clearQuery: vi.fn() };

    callback(handle);
    expect(handles.get(5)).toBe(handle);
    expect(setActiveKey).not.toHaveBeenCalled();

    activeId.current = 5;
    callback(handle);
    expect(setActiveKey).toHaveBeenLastCalledWith(searchObjectKey(handle));

    callback(null);
    expect(handles.has(5)).toBe(false);
    expect(setActiveKey).toHaveBeenLastCalledWith(null);
  });
});
