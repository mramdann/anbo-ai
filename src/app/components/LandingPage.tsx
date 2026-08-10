import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { WindowControls } from "@/components/WindowControls";
import { Folder01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { open } from "@tauri-apps/plugin-dialog";
import { useState } from "react";
import { WorkspaceConstellation } from "./WorkspaceConstellation";

type LandingPageProps = {
  onPick: (dir: string, name: string) => void;
  onUseHome: () => void;
  home: string | null;
  title?: string;
  description?: string;
  /** Render min/max/close controls — use when no Header is present (e.g. the
   * first-run landing). */
  showWindowControls?: boolean;
};

/** First-run empty state: no workspace chosen yet. Pick a folder (and optionally name it). */
export function LandingPage({
  onPick,
  onUseHome,
  home,
  title = "anbo",
  description = "Choose a folder to start working in. You can name it, or leave it blank to use the folder name.",
  showWindowControls = false,
}: LandingPageProps) {
  const [name, setName] = useState("");

  const chooseFolder = async () => {
    const selected = await open({ directory: true, multiple: false });
    if (!selected) return; // user cancelled
    const dir = selected.replace(/\\/g, "/");
    // Default the workspace name to the folder basename when left empty.
    const resolved =
      name.trim() || dir.replace(/\/+$/, "").split("/").pop() || "workspace";
    onPick(dir, resolved);
  };

  return (
    <div className="relative flex h-full w-full items-center justify-center overflow-y-auto bg-background p-8">
      <WorkspaceConstellation />
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(circle at 50% 36%, color-mix(in oklab, var(--background) 72%, transparent), transparent 68%)",
        }}
      />
      {showWindowControls ? (
        <div
          data-tauri-drag-region
          className="absolute inset-x-0 top-0 z-30 flex h-9 items-stretch justify-end"
        >
          <WindowControls />
        </div>
      ) : null}
      <Empty className="relative">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <HugeiconsIcon icon={Folder01Icon} />
          </EmptyMedia>
          <EmptyTitle>{title}</EmptyTitle>
          <EmptyDescription>{description}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Workspace name (optional)"
            className="w-72"
            onKeyDown={(e) => {
              if (e.key === "Enter") void chooseFolder();
            }}
          />
          <Button size="lg" onClick={chooseFolder}>
            <HugeiconsIcon icon={Folder01Icon} className="size-4" />
            Choose folder
          </Button>
          {home ? (
            <Button variant="ghost" size="sm" onClick={onUseHome}>
              or use home directory
            </Button>
          ) : null}
        </EmptyContent>
      </Empty>
    </div>
  );
}
