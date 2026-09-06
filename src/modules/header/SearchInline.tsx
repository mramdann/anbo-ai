import { Button } from "@/components/ui/button";
import { KEY_SEP } from "@/lib/platform";
import { cn } from "@/lib/utils";
import type { EditorPaneHandle } from "@/modules/editor";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { getBindingTokens, SHORTCUTS } from "@/modules/shortcuts/shortcuts";
import {
  ArrowDown01Icon,
  ArrowUp01Icon,
  Cancel01Icon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { SearchAddon } from "@xterm/addon-search";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";

const TERM_DECORATIONS = {
  matchBackground: "#515c6a",
  activeMatchBackground: "#d18616",
  matchOverviewRuler: "#d18616",
  activeMatchColorOverviewRuler: "#d18616",
};

export type SearchTarget =
  | { kind: "terminal"; addon: SearchAddon; focus: () => void }
  | { kind: "editor"; handle: EditorPaneHandle; focus: () => void }
  | {
      kind: "git-history";
      handle: { setQuery: (q: string) => void; clearQuery: () => void };
      focus: () => void;
    }
  | null;

export type SearchInlineHandle = { focus: () => void };

type Props = {
  target: SearchTarget;
  /** When true, collapse to an icon-only button until the user opens it. */
  compact?: boolean;
};

export const SearchInline = forwardRef<SearchInlineHandle, Props>(
  function SearchInline({ target, compact }, ref) {
    const [q, setQ] = useState("");
    const [focused, setFocused] = useState(false);
    // Where the terminal's active match sits among all matches. Only the
    // terminal reports this; the editor and history filter keep it null.
    const [results, setResults] = useState<{
      index: number;
      count: number;
    } | null>(null);
    // In compact mode the field is hidden behind an icon until activated.
    // In normal mode the field is always present.
    const [openInCompact, setOpenInCompact] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);
    const pendingFocusRef = useRef(false);
    const setInputRef = useCallback((el: HTMLInputElement | null) => {
      inputRef.current = el;
      if (!el || !pendingFocusRef.current) return;
      pendingFocusRef.current = false;
      el.focus();
    }, []);

    const userShortcuts = usePreferencesStore((s) => s.shortcuts);

    const shortcutText = useMemo(() => {
      const s = SHORTCUTS.find((s) => s.id === "search.focus");
      if (!s) return "";
      const bindings = userShortcuts["search.focus"] || s.defaultBindings;
      if (!bindings || bindings.length === 0) return "";
      const tokens = getBindingTokens(bindings[0]);
      return tokens.join(KEY_SEP);
    }, [userShortcuts]);

    const baseLabel =
      target?.kind === "git-history"
        ? "Filter history"
        : target?.kind === "editor"
          ? "Search in file"
          : target?.kind === "terminal"
            ? "Search terminal"
            : "Search";

    const placeholder = baseLabel;

    const tooltipTitle = useMemo(() => {
      return shortcutText ? `${baseLabel} (${shortcutText})` : baseLabel;
    }, [baseLabel, shortcutText]);

    const expanded = !compact || openInCompact;

    const focus = useCallback(() => {
      pendingFocusRef.current = true;
      if (compact) setOpenInCompact(true);
      else inputRef.current?.focus();
      if (inputRef.current) pendingFocusRef.current = false;
    }, [compact]);

    useImperativeHandle(ref, () => ({ focus }), [focus]);

    const clearTarget = useCallback(() => {
      if (!target) return;
      if (target.kind === "terminal") target.addon.clearDecorations();
      else target.handle.clearQuery();
    }, [target]);

    const restoreTargetFocus = useCallback(() => {
      if (!target) return;
      target.focus();
    }, [target]);

    // Target switched (terminal ↔ editor) or removed → drop highlights.
    useEffect(() => clearTarget, [clearTarget]);

    useEffect(() => {
      setResults(null);
      if (target?.kind !== "terminal") return;
      const sub = target.addon.onDidChangeResults((e) =>
        setResults({ index: e.resultIndex, count: e.resultCount }),
      );
      return () => sub.dispose();
    }, [target]);

    const applyIncremental = (next: string) => {
      if (!target) return;
      if (target.kind === "terminal") {
        if (next) {
          target.addon.findNext(next, {
            incremental: true,
            decorations: TERM_DECORATIONS,
          });
        } else {
          target.addon.clearDecorations();
          setResults(null);
        }
      } else {
        target.handle.setQuery(next);
      }
    };

    const findDirection = (forward: boolean) => {
      if (!target || !q) return;
      if (target.kind === "terminal") {
        const opts = { decorations: TERM_DECORATIONS };
        if (forward) target.addon.findNext(q, opts);
        else target.addon.findPrevious(q, opts);
      } else if (target.kind === "editor") {
        if (forward) target.handle.findNext();
        else target.handle.findPrevious();
      }
      // git-history: the list filters live; Enter has no next/prev semantics.
    };

    const clear = () => {
      setQ("");
      setResults(null);
      clearTarget();
    };

    // The chip shows the shortcut while the field is idle; once it has focus
    // or text, that room goes to the match count and the controls.
    const hint = shortcutText && !q && !focused ? shortcutText : null;
    const counter =
      q && target?.kind === "terminal" && results
        ? results.count === 0
          ? "0"
          : results.index >= 0
            ? `${results.index + 1}/${results.count}`
            : `${results.count}`
        : null;
    const noMatch = counter === "0";
    const canStep = !!q && target?.kind === "terminal" && !noMatch;

    return (
      <div
        className="relative h-6 shrink-0 transition-[width] duration-200 ease-out"
        style={{ width: expanded ? (focused || q ? 256 : 200) : 24 }}
      >
        {expanded ? (
          <div
            className={cn(
              "absolute inset-0 flex items-center gap-1 rounded-md border border-border/60 bg-muted/40 pr-1 pl-1.5 transition-[background-color,border-color,box-shadow] duration-150 animate-in fade-in-0",
              "hover:bg-muted/60 focus-within:border-primary/50 focus-within:bg-background focus-within:ring-2 focus-within:ring-primary/15",
              noMatch &&
                "focus-within:border-destructive/50 focus-within:ring-destructive/15",
            )}
          >
            <HugeiconsIcon
              icon={Search01Icon}
              size={13}
              strokeWidth={1.75}
              className="shrink-0 text-muted-foreground"
            />
            <input
              ref={setInputRef}
              value={q}
              placeholder={placeholder}
              spellCheck={false}
              autoComplete="off"
              aria-label={baseLabel}
              className="h-full min-w-0 flex-1 bg-transparent text-[12.5px] text-foreground outline-none placeholder:text-muted-foreground/70"
              onFocus={() => setFocused(true)}
              onBlur={() => {
                setFocused(false);
                if (compact && !q) setOpenInCompact(false);
              }}
              onChange={(e) => {
                const next = e.target.value;
                setQ(next);
                applyIncremental(next);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  findDirection(!e.shiftKey);
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  clear();
                  if (compact) {
                    setOpenInCompact(false);
                  }
                  restoreTargetFocus();
                }
              }}
            />
            {hint && (
              <kbd className="pointer-events-none shrink-0 rounded border border-border/60 px-1 font-sans text-[10px] leading-4 text-muted-foreground/70 select-none">
                {hint}
              </kbd>
            )}
            {counter && (
              <span
                className={cn(
                  "shrink-0 px-0.5 text-[10.5px] tabular-nums",
                  noMatch ? "text-destructive" : "text-muted-foreground",
                )}
              >
                {counter}
              </span>
            )}
            {canStep && (
              <>
                <button
                  type="button"
                  tabIndex={-1}
                  title="Previous match (Shift+Enter)"
                  aria-label="Previous match"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => findDirection(false)}
                  className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <HugeiconsIcon
                    icon={ArrowUp01Icon}
                    size={12}
                    strokeWidth={2}
                  />
                </button>
                <button
                  type="button"
                  tabIndex={-1}
                  title="Next match (Enter)"
                  aria-label="Next match"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => findDirection(true)}
                  className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <HugeiconsIcon
                    icon={ArrowDown01Icon}
                    size={12}
                    strokeWidth={2}
                  />
                </button>
              </>
            )}
            {q && (
              <button
                type="button"
                tabIndex={-1}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  clear();
                  inputRef.current?.focus();
                }}
                className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                aria-label="Clear search"
              >
                <HugeiconsIcon icon={Cancel01Icon} size={11} strokeWidth={2} />
              </button>
            )}
          </div>
        ) : (
          <div className="absolute inset-0 flex items-center justify-end animate-in fade-in-0 duration-150">
            <Button
              variant="ghost"
              size="icon"
              className="size-6 shrink-0 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={focus}
              title={tooltipTitle}
            >
              <HugeiconsIcon
                icon={Search01Icon}
                size={14}
                strokeWidth={1.75}
                className="size-3.5"
              />
            </Button>
          </div>
        )}
      </div>
    );
  },
);
