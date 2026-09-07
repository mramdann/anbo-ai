import { useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { renameSelectionEnd } from "./lib/rename";

type Props = {
  initial: string;
  placeholder?: string;
  onCommit: (value: string) => void | Promise<void>;
  onCancel: () => void;
  isDirectory?: boolean;
  ariaLabel?: string;
  errorTitle?: string;
};

/**
 * Self-focusing single-line input for rename / create flows in the tree.
 * Enter commits, Escape cancels, blur commits (matches VSCode behavior —
 * dismissing the input is an implicit commit so a typed name isn't lost).
 */
export function InlineInput({
  initial,
  placeholder,
  onCommit,
  onCancel,
  isDirectory = false,
  ariaLabel,
  errorTitle = "Could not save name",
}: Props) {
  const [value, setValue] = useState(initial);
  const [pending, setPending] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  const committedRef = useRef(false);
  const settledRef = useRef(false);
  const mountedRef = useRef(false);

  useLayoutEffect(() => {
    mountedRef.current = true;
    const el = ref.current;
    if (!el) return;
    // Two-tick focus to win against parent click handlers and Radix portal
    // restorations that can steal focus right after mount. Until the second
    // tick lands we treat the input as "unsettled" — any blur during that
    // window is the portal teardown stealing focus, not the user dismissing
    // the input, so we refocus instead of committing an empty value.
    //
    // preventScroll matters here (#123): the input mounts inside the
    // sidebar's flex column, which is small enough that focus-scroll can
    // nudge the parent's scroll position by a fraction of a pixel each
    // cycle. Repeated open/cancel pairs accumulate and walk the tree off
    // the left edge. We're already rendering the input where it should be
    // visible — there is no scroll-into-view we need from focus().
    const focus = () => {
      el.focus({ preventScroll: true });
      el.setSelectionRange(0, renameSelectionEnd(initial, isDirectory));
    };
    focus();
    const raf = requestAnimationFrame(() => focus());
    const timer = setTimeout(() => {
      focus();
      settledRef.current = true;
    }, 170);
    return () => {
      mountedRef.current = false;
      cancelAnimationFrame(raf);
      clearTimeout(timer);
    };
  }, [initial, isDirectory]);

  const commit = async () => {
    if (committedRef.current) return;
    committedRef.current = true;
    setPending(true);
    try {
      await onCommit(value);
    } catch (error) {
      toast.error(errorTitle, {
        description: error instanceof Error ? error.message : String(error),
      });
      if (mountedRef.current) {
        committedRef.current = false;
        ref.current?.focus({ preventScroll: true });
      }
    } finally {
      if (mountedRef.current) setPending(false);
    }
  };
  const cancel = () => {
    if (committedRef.current) return;
    committedRef.current = true;
    onCancel();
  };

  return (
    <input
      ref={ref}
      value={value}
      placeholder={placeholder}
      aria-label={ariaLabel ?? placeholder}
      aria-busy={pending}
      readOnly={pending}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return;
        if (e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          void commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          cancel();
        }
      }}
      onBlur={() => {
        if (!settledRef.current) {
          ref.current?.focus({ preventScroll: true });
          return;
        }
        void commit();
      }}
      className="flex-1 min-w-0 truncate rounded-sm border border-border bg-background px-1.5 py-0.5 text-xs text-foreground outline-none ring-0 focus:border-ring"
    />
  );
}
