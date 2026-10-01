import { cn } from "@/lib/utils";
import { browserName } from "@/modules/browser/external/store";

/** The browser's logo (SVG from svgl.app, in public/browser-icons). */
export function BrowserLogo({
  browser,
  className,
  title,
}: {
  browser: "chrome" | "edge";
  className?: string;
  /** Tooltip; the browser's name when absent. */
  title?: string;
}) {
  const name = browserName(browser);
  return (
    <img
      src={`/browser-icons/${browser}.svg`}
      alt={name}
      title={title ?? name}
      draggable={false}
      className={cn("size-3.5 shrink-0 object-contain", className)}
    />
  );
}
