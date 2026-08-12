import { AgentIcon } from "@/modules/agents/lib/agentIcon";
import { googleFaviconUrlForPage } from "@/modules/browser/browserInput";
import { fileIconUrl } from "@/modules/explorer/lib/iconResolver";
import {
  leafIds,
  ptyIdForLeaf,
  tabAgentStatus,
  useAgentActivityStore,
} from "@/modules/terminal";
import {
  CheckmarkCircle01Icon,
  Clock01Icon,
  ComputerTerminal02Icon,
  GitCompareIcon,
  Globe02Icon,
  IncognitoIcon,
  Message02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import type { Tab } from "./lib/useTabs";

function useTabAgentStatus(tab: Tab) {
  const phases = useAgentActivityStore((state) => state.phases);
  const agents = useAgentActivityStore((state) => state.agents);
  if (tab.kind !== "terminal" || tab.private) {
    return { state: null, agent: null } as const;
  }
  const ptyIds: number[] = [];
  for (const leaf of leafIds(tab.paneTree)) {
    const id = ptyIdForLeaf(leaf);
    if (id !== null) ptyIds.push(id);
  }
  return tabAgentStatus(phases, agents, ptyIds);
}

type TabIconSize = "sm" | "md";

export function TabIcon({
  tab,
  size = "md",
}: {
  tab: Tab;
  size?: TabIconSize;
}) {
  const agentStatus = useTabAgentStatus(tab);
  const pixels = size === "sm" ? 12 : 14;
  const iconClass = size === "sm" ? "size-3" : "size-3.5";
  if (tab.kind === "editor" || tab.kind === "markdown") {
    const url =
      tab.kind === "editor" && tab.overrideLanguage
        ? fileIconUrl(`dummy.${tab.overrideLanguage}`)
        : fileIconUrl(tab.title);
    return url ? (
      <img
        src={url}
        alt=""
        className={`${iconClass} shrink-0 object-contain`}
        onError={(event) => {
          const image = event.currentTarget;
          if (image.dataset.fallback) return;
          image.dataset.fallback = "1";
          image.src = fileIconUrl("dummy.txt");
        }}
      />
    ) : null;
  }
  if (tab.kind === "browser") {
    // While the page is loading, show a spinner in place of the favicon so the
    // loading state sits right where the icon normally would.
    if (tab.loading) {
      return (
        <span
          aria-label="Loading"
          className={`${iconClass} shrink-0 animate-spin rounded-full border-[1.5px] border-current border-t-transparent`}
        />
      );
    }
    return (
      <PreviewIcon
        favicon={tab.favicon}
        fallback={googleFaviconUrlForPage(tab.url)}
        pixels={pixels}
        className={iconClass}
      />
    );
  }
  if (
    tab.kind === "ai-diff" ||
    tab.kind === "git-diff" ||
    tab.kind === "git-commit-file"
  ) {
    return <TabGlyph icon={GitCompareIcon} pixels={pixels} />;
  }
  if (tab.kind === "terminal" && tab.private) {
    return <TabGlyph icon={IncognitoIcon} pixels={pixels} />;
  }
  if (tab.kind === "git-history") {
    return <TabGlyph icon={Clock01Icon} pixels={pixels} />;
  }
  if (agentStatus.state === "attention") {
    return <TabGlyph icon={Message02Icon} pixels={pixels} />;
  }
  if (agentStatus.state === "finished") {
    return <TabGlyph icon={CheckmarkCircle01Icon} pixels={pixels} />;
  }
  if (agentStatus.state === "working" && agentStatus.agent) {
    return (
      <AgentIcon agent={agentStatus.agent} size={pixels} className="shrink-0" />
    );
  }
  return <TabGlyph icon={ComputerTerminal02Icon} pixels={pixels} />;
}

function PreviewIcon({
  favicon,
  fallback,
  pixels,
  className,
}: {
  favicon?: string | null;
  fallback?: string | null;
  pixels: number;
  className: string;
}) {
  // Track load failure in React state — never mutate the DOM directly from
  // onError. Removing the <img> node by hand desyncs React's DOM model and
  // throws "removeChild: node is not a child" on the next commit (the
  // blank-screen crash when a favicon 404s during agent-driven navigation).
  //
  // Try sources in order: the site's own /favicon.ico first (works for standard
  // + local sites), then Google's favicon service (catches sites whose icon
  // lives at a custom <link rel="icon"> path). Fall through to the globe glyph
  // when both fail.
  const sources = [favicon, fallback].filter(Boolean) as string[];
  const [index, setIndex] = useState(0);
  useEffect(() => {
    setIndex(0);
  }, [favicon, fallback]);
  const src = sources[index];
  if (!src) return <TabGlyph icon={Globe02Icon} pixels={pixels} />;
  return (
    <img
      key={src}
      src={src}
      alt=""
      className={`${className} shrink-0 rounded-[2px] object-contain`}
      onError={() => setIndex((idx) => idx + 1)}
    />
  );
}

function TabGlyph({
  icon,
  pixels,
}: {
  icon: typeof Globe02Icon;
  pixels: number;
}) {
  return (
    <HugeiconsIcon
      icon={icon}
      size={pixels}
      strokeWidth={2}
      className="shrink-0"
    />
  );
}
