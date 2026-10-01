import { trackToasterChanges } from "@/modules/browser/nativeVisibility";
import { useTheme } from "@/modules/theme";
import { useEffect, useRef } from "react";
import { Toaster as Sonner, type ToasterProps } from "sonner";

const Toaster = ({ ...props }: ToasterProps) => {
  const { resolvedMode } = useTheme();
  const root = useRef<HTMLDivElement>(null);

  // A native browser page is cut around every toast on screen, so it has to
  // hear when a toast arrives, moves or leaves. Over such a page toasts run no
  // transition that could announce it (see globals.css), and neither do they
  // under reduced motion. Only the toaster's own subtree is watched.
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const observer = new MutationObserver((records) =>
      trackToasterChanges(records),
    );
    observer.observe(element, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: [
        "data-mounted",
        "data-removed",
        "data-visible",
        "data-swipe-out",
        "style",
      ],
    });
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={root} className="contents">
      <Sonner
        theme={resolvedMode}
        className="toaster group"
        expand
        visibleToasts={4}
        style={
          {
            "--normal-bg": "var(--popover)",
            "--normal-text": "var(--popover-foreground)",
            "--normal-border": "var(--border)",
            "--border-radius": "var(--radius)",
          } as React.CSSProperties
        }
        {...props}
      />
    </div>
  );
};

export { Toaster };
