import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ResumeSummary } from "./lib/resumeGate";
import { ResumeGate } from "./ResumeGate";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, "ResumeGate.tsx"), "utf8");

const summary: ResumeSummary = {
  agents: ["Claude", "Codex", "Kimi"],
  terminals: 2,
  pages: 4,
  files: 0,
  others: 0,
  titles: [
    "Claude",
    "Codex",
    "Kimi",
    "server",
    "logs",
    "localhost",
    "Docs",
    "Issues",
    "Mail",
  ],
};

function render(over: Partial<Parameters<typeof ResumeGate>[0]> = {}) {
  const nothing = () => {};
  return renderToStaticMarkup(
    <ResumeGate
      name="anbo-ai"
      summary={summary}
      backTo="benchmark-anbo"
      onResume={nothing}
      onStartFresh={nothing}
      onBack={nothing}
      {...over}
    />,
  );
}

describe("ResumeGate", () => {
  it("names the workspace, what sleeps in it and its agents", () => {
    const html = render();
    expect(html).toContain("Resume &quot;anbo-ai&quot;?");
    expect(html).toContain("3 agents, 2 terminals, 4 browser tabs");
    expect(html).toContain("Claude, Codex, Kimi");
    expect(html).toContain("No shell, agent or page starts until you choose.");
  });

  it("offers the three answers, with the way back by name", () => {
    const html = render();
    expect(html).toContain("Resume");
    expect(html).toContain("Start fresh");
    expect(html).toContain("Back to benchmark-anbo");
  });

  it("has no way back when there is no workspace to go back to", () => {
    expect(render({ backTo: null })).not.toContain("Back to");
  });

  it("shows eight tab labels and counts the rest", () => {
    const html = render();
    expect(html).toContain("Issues");
    expect(html).not.toContain("Mail");
    expect(html).toContain("+1");
  });

  it("closes the tabs only from the second question", () => {
    expect(source).toContain(
      '<Button variant="outline" onClick={() => setConfirming(true)}>',
    );
    expect(source.match(/onClick=\{onStartFresh\}/g)).toHaveLength(1);
    expect(source).toContain(
      '<Button variant="destructive" onClick={onStartFresh}>',
    );
  });

  it("starts nothing by itself: no timer, no animation", () => {
    expect(source).not.toMatch(/setTimeout|setInterval|animate-|useEffect/);
  });
});
