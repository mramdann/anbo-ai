import { resolveAgentBrandAsset } from "@/modules/agents/lib/agentIconAssets";
import { AiBrowserIcon, BotIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";

function AgentBrandImage({
  lightSrc,
  darkSrc,
  invertOnDark,
  size,
  className,
}: {
  lightSrc: string;
  darkSrc?: string;
  invertOnDark?: boolean;
  size: number;
  className?: string;
}) {
  const sharedClassName = "block size-full object-contain";
  return (
    <span
      className={`relative inline-flex shrink-0 ${className ?? ""}`}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <img
        src={lightSrc}
        alt=""
        draggable={false}
        className={`${sharedClassName} ${darkSrc ? "dark:hidden" : ""} ${invertOnDark ? "dark:invert" : ""}`}
      />
      {darkSrc ? (
        <img
          src={darkSrc}
          alt=""
          draggable={false}
          className={`${sharedClassName} hidden dark:block`}
        />
      ) : null}
    </span>
  );
}

function iconFor(agent: string): IconSvgElement {
  return agent.toLowerCase() === "robot" ? BotIcon : AiBrowserIcon;
}

export function AgentIcon({
  agent,
  size = 15,
  className,
  tone = "current",
}: {
  agent: string;
  size?: number;
  className?: string;
  tone?: "current" | "brand";
}) {
  const asset = resolveAgentBrandAsset(agent);
  if (asset) {
    return (
      <AgentBrandImage
        lightSrc={asset.light}
        darkSrc={asset.dark}
        invertOnDark={asset.invertOnDark}
        size={size}
        className={className}
      />
    );
  }
  if (agent.toLowerCase().includes("anbo")) {
    return (
      <AgentBrandImage lightSrc="/logo.svg" size={size} className={className} />
    );
  }
  const style = tone === "brand" ? { color: "var(--primary)" } : undefined;
  return (
    <span style={style} className="inline-flex shrink-0">
      <HugeiconsIcon
        icon={iconFor(agent)}
        size={size}
        strokeWidth={1.75}
        className={className}
      />
    </span>
  );
}
