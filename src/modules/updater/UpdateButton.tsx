import { Button } from "@/components/ui/button";
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
 * taking over the screen. Being the one filled control in a header of muted
 * ones is what makes it noticeable; the light crossing it every few seconds is
 * what keeps it noticed. Pressing it opens the version and its changelog, and
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
      {/* A solid pill needs no badge and no arrow: nothing else in the header
          is filled, so the fill is the whole signal. Being filled also makes
          it read heavier than its neighbours, so it sits a size below them
          rather than matching their height. */}
      <Button
        type="button"
        size="sm"
        onClick={() => setOpen(true)}
        title={label}
        aria-label={label}
        className="anbo-sheen h-5 shrink-0 rounded-md px-2 text-[10px]"
      >
        {ready ? "Restart" : busy ? "Updating…" : "Update"}
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
