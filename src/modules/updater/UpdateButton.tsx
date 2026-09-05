import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ArrowUp01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { lazy, Suspense, useState } from "react";

// The dialog pulls in the dialog primitives and a markdown renderer for the
// changelog. None of that is worth carrying in the header's startup path for a
// button most sessions never press.
const UpdaterDialog = lazy(() =>
  import("./UpdaterDialog").then((m) => ({ default: m.UpdaterDialog })),
);
import { shouldOfferUpdate, useUpdater } from "./useUpdater";

/**
 * The only sign that an update exists, sitting beside the workspace name.
 *
 * A release is news, not an emergency, so it waits to be noticed rather than
 * taking over the screen. Pressing it opens the version and its changelog, and
 * closing that leaves the button where it was.
 */
export function UpdateButton() {
  const { status, install } = useUpdater();
  const [open, setOpen] = useState(false);

  if (!shouldOfferUpdate(status)) return null;
  const version = status.kind === "available" ? status.update.version : null;
  const busy = status.kind === "downloading";
  const ready = status.kind === "ready";

  const label = ready
    ? "Restart to finish updating"
    : busy
      ? "Downloading update"
      : `Anbo v${version} is available`;

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
        title={label}
        aria-label={label}
        className={cn(
          "h-7 shrink-0 gap-1 rounded-md px-1.5 text-[11px]",
          "text-primary hover:bg-primary/10 hover:text-primary",
        )}
      >
        <HugeiconsIcon icon={ArrowUp01Icon} size={13} strokeWidth={2} />
        <span className="hidden sm:inline">
          {ready ? "Restart" : busy ? "Updating…" : "Update"}
        </span>
      </Button>
      {open && (
        <Suspense fallback={null}>
          <UpdaterDialog
            open={open}
            onOpenChange={setOpen}
            status={status}
            install={install}
          />
        </Suspense>
      )}
    </>
  );
}
