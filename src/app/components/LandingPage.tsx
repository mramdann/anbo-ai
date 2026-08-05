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
import { Folder01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { open } from "@tauri-apps/plugin-dialog";
import { useState } from "react";

type LandingPageProps = {
  onPick: (dir: string, name: string) => void;
  onUseHome: () => void;
  home: string | null;
  title?: string;
  description?: string;
};

/** First-run empty state: no workspace chosen yet. Pick a folder (and optionally name it). */
export function LandingPage({
  onPick,
  onUseHome,
  home,
  title = "anbo",
  description = "Choose a folder to start working in. You can name it, or leave it blank to use the folder name.",
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
    <div className="flex h-full w-full items-center justify-center bg-background p-8">
      <Empty>
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
