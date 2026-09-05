import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { lazy, Suspense } from "react";
import type { UpdaterStatus } from "./useUpdater";

const Streamdown = lazy(() =>
  import("streamdown").then((module) => ({ default: module.Streamdown })),
);

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  status: UpdaterStatus;
  install: () => void | Promise<void>;
};

/**
 * The update details, shown only when the user asks for them.
 *
 * This used to open itself the moment a release was found, which interrupted
 * whatever was on screen to deliver news that was never urgent. It is now
 * opened from the button in the header.
 */
export function UpdaterDialog({ open, onOpenChange, status, install }: Props) {
  if (!open) return null;

  const update = status.kind === "available" ? status.update : null;
  const downloading = status.kind === "downloading";
  const ready = status.kind === "ready";

  const progress =
    downloading && status.contentLength
      ? Math.min(100, (status.downloaded / status.contentLength) * 100)
      : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>
            {ready
              ? "Update ready"
              : downloading
                ? "Downloading update…"
                : `Anbo v${update?.version} is available`}
          </DialogTitle>
          <DialogDescription>
            {ready
              ? "Restart Anbo to finish installing."
              : downloading
                ? progress !== null
                  ? `${progress.toFixed(0)}% — ${formatBytes(status.downloaded)}`
                  : formatBytes(status.downloaded)
                : "A new version is ready to install."}
          </DialogDescription>
        </DialogHeader>

        {update?.body && (
          <div className="max-h-[40vh] overflow-y-auto rounded-md border border-border/40 bg-muted/20 px-3 py-2 text-xs leading-relaxed [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_a]:break-words [&_a]:text-primary [&_a]:underline [&_h1]:mt-2 [&_h1]:text-sm [&_h1]:font-semibold [&_h2]:mt-2 [&_h2]:text-sm [&_h2]:font-semibold [&_h3]:mt-2 [&_h3]:text-xs [&_h3]:font-semibold [&_h3]:uppercase [&_h3]:tracking-wide [&_h3]:text-muted-foreground [&_li]:my-0 [&_ol]:my-1 [&_p]:text-xs [&_ul]:my-1">
            <Suspense
              fallback={<p className="whitespace-pre-wrap">{update.body}</p>}
            >
              <Streamdown>{update.body}</Streamdown>
            </Suspense>
          </div>
        )}

        {downloading && progress !== null && (
          <Progress value={progress} className="mt-2" />
        )}
        {downloading && progress === null && (
          <Progress value={undefined} className="mt-2 animate-pulse" />
        )}

        <DialogFooter>
          {status.kind === "available" && (
            <>
              {/* Closing leaves the header button in place, so the update is
                  never lost, only postponed. */}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onOpenChange(false)}
              >
                Later
              </Button>
              <Button size="sm" onClick={() => void install()}>
                Install &amp; restart
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
