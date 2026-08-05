import { Folder01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { NewTabMenu } from "@/modules/tabs/NewTabMenu";
import type { AgentLaunchRequest } from "@/modules/agents/lib/launcher";

type WorkspaceWelcomeProps = {
  name: string | null;
  folder: string | null;
  onNew: () => void;
  onNewBlock: () => void;
  onNewPrivate: () => void;
  onNewPreview: () => void;
  onNewEditor: () => void;
  onNewGitGraph: () => void;
  onLaunchAgents: (request: AgentLaunchRequest) => void;
};

/**
 * A workspace is open but no tab is open yet. Offer the same actions as the
 * "new tab" menu (terminal / blocks / agents / privacy / editor / preview /
 * git graph) instead of auto-spawning a terminal on workspace creation.
 */
export function WorkspaceWelcome({
  name,
  folder,
  onNew,
  onNewBlock,
  onNewPrivate,
  onNewPreview,
  onNewEditor,
  onNewGitGraph,
  onLaunchAgents,
}: WorkspaceWelcomeProps) {
  return (
    <div className="flex h-full w-full items-center justify-center bg-background p-8">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <HugeiconsIcon icon={Folder01Icon} />
          </EmptyMedia>
          <EmptyTitle>{name ?? "Workspace ready"}</EmptyTitle>
          <EmptyDescription>
            {folder
              ? `Working in ${folder}. Open a tab to get started.`
              : "Open a tab to get started."}
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button size="lg" onClick={onNew}>
            Open terminal
          </Button>
          <NewTabMenu
            onNew={onNew}
            onNewBlock={onNewBlock}
            onNewPrivate={onNewPrivate}
            onNewPreview={onNewPreview}
            onNewEditor={onNewEditor}
            onNewGitGraph={onNewGitGraph}
            onLaunchAgents={onLaunchAgents}
          />
        </EmptyContent>
      </Empty>
    </div>
  );
}
