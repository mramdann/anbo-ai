import { Button } from "@/components/ui/button";
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
      {/* Same shape as the Ports button, and the same way the notification
          bell marks news: a muted control with one primary dot. */}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
        title={label}
        aria-label={label}
        className="relative h-7 shrink-0 gap-1 rounded-md px-1.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <HugeiconsIcon icon={ArrowUp01Icon} size={13} strokeWidth={1.75} />
        <span className="hidden sm:inline">
          {ready ? "Restart" : busy ? "Updating…" : "Update"}
        </span>
        {busy ? null : (
          <span className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-primary" />
        )}
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
