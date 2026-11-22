import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { useState } from "react";
import { listed } from "./lib/pauseSpace";
import { type ResumeSummary, resumeSummaryLine } from "./lib/resumeGate";

const SHOWN_TITLES = 8;

type Props = {
  name: string;
  summary: ResumeSummary;
  /** The workspace the user came from, when there is one to go back to. */
  backTo: string | null;
  onResume: () => void;
  onStartFresh: () => void;
  onBack: () => void;
};

// A stable ref callback: the button takes the focus once, when it mounts.
function focusOnMount(node: HTMLButtonElement | null) {
  node?.focus();
}

/**
 * Asked before a workspace's saved tabs come back, so a workspace opened by
 * mistake starts nothing. Start fresh asks once more, because it drops the
 * workspace's tabs.
 */
export function ResumeGate({
  name,
  summary,
  backTo,
  onResume,
  onStartFresh,
  onBack,
}: Props) {
  const [confirming, setConfirming] = useState(false);
  const total = summary.titles.length;
  const more = total - SHOWN_TITLES;
  return (
    <section
      aria-labelledby="resume-gate-title"
      className="flex h-full w-full overflow-y-auto bg-background"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        if (confirming) setConfirming(false);
        else if (backTo) onBack();
      }}
    >
      <div className="m-auto w-full max-w-[34rem] px-6 py-10 text-center">
        <ul
          aria-label="Saved tabs"
          className="flex flex-wrap justify-center gap-1.5"
        >
          {summary.titles.slice(0, SHOWN_TITLES).map((title, index) => (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: tab labels repeat, and this list never reorders
              key={index}
              className="max-w-40 truncate rounded-md border border-border/60 px-2 py-0.5 font-mono text-[11px] text-muted-foreground/70"
            >
              {title}
            </li>
          ))}
          {more > 0 ? (
            <li className="px-1 py-0.5 font-mono text-[11px] text-muted-foreground/55">
              +{more}
            </li>
          ) : null}
        </ul>
        <h1
          id="resume-gate-title"
          className="mt-6 truncate font-heading text-[24px] font-semibold tracking-[-0.02em] text-foreground"
        >
          {confirming
            ? `Close ${total === 1 ? "the tab" : `all ${total} tabs`} of "${name}"?`
            : `Resume "${name}"?`}
        </h1>
        <p className="mx-auto mt-2 max-w-md text-[13px] leading-relaxed text-muted-foreground/85">
          {confirming
            ? "The tabs and their layout go. Agents keep their conversations in their own history; files on disk stay."
            : resumeSummaryLine(summary)}
        </p>
        {!confirming && summary.agents.length > 0 ? (
          <p className="mx-auto mt-1 max-w-md truncate font-mono text-[11px] text-muted-foreground/70">
            {listed(summary.agents)}
          </p>
        ) : null}
        <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
          {confirming ? (
            <>
              <Button variant="destructive" onClick={onStartFresh}>
                Close tabs
              </Button>
              <Button
                ref={focusOnMount}
                variant="outline"
                onClick={() => setConfirming(false)}
              >
                Cancel
              </Button>
            </>
          ) : (
            <>
              <Button ref={focusOnMount} onClick={onResume}>
                Resume
                <Kbd>Enter</Kbd>
              </Button>
              <Button variant="outline" onClick={() => setConfirming(true)}>
                Start fresh
              </Button>
              {backTo ? (
                <Button variant="ghost" onClick={onBack}>
                  Back to {backTo}
                  <Kbd>Esc</Kbd>
                </Button>
              ) : null}
            </>
          )}
        </div>
        {confirming ? null : (
          <p className="mt-5 text-[11px] text-muted-foreground/55">
            No shell, agent or page starts until you choose.
          </p>
        )}
      </div>
    </section>
  );
}
