import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TotalRow } from "./UsageDialog";

const here = path.dirname(fileURLToPath(import.meta.url));
const view = readFileSync(path.join(here, "UsageDialog.tsx"), "utf8");
const MB = 1024 * 1024;

describe("the Task Manager's totals", () => {
  it("puts this computer's figures in the list's columns, the installed memory beside them", () => {
    const row = renderToStaticMarkup(
      <TotalRow
        name="This computer"
        cpu={25}
        memory={5.3 * 1024 * MB}
        of={8 * 1024 * MB}
      />,
    );
    expect(row).toContain("grid-cols-[minmax(0,1fr)_4.25rem_5rem_4.75rem]");
    expect(row).toMatch(
      />This computer<\/span><\/span><span[^>]*>25%<\/span><span[^>]*>5\.3 GB<\/span><span[^>]*>of 8\.0 GB<\/span><\/div>$/,
    );
  });

  it("puts Anbo's figures in the same two columns and says what they add up", () => {
    const row = renderToStaticMarkup(
      <TotalRow
        name="Anbo"
        note="everything below"
        cpu={2.1}
        memory={406 * MB}
      />,
    );
    // The last cell stays, empty: without it the figures would move a column.
    expect(row).toMatch(
      />Anbo<\/span><span[^>]*>everything below<\/span><\/span><span[^>]*>2\.1%<\/span><span[^>]*>406 MB<\/span><span[^>]*><\/span><\/div>$/,
    );
  });

  it("gives a total's figures the classes a workspace's line has", () => {
    const row = renderToStaticMarkup(
      <TotalRow name="Anbo" cpu={2.1} memory={406 * MB} />,
    );
    expect(row).toContain(
      '<span class="text-right text-[12px] tabular-nums text-muted-foreground">2.1%</span>',
    );
    expect(row).toContain(
      '<span class="text-right text-[12px] font-medium tabular-nums text-foreground">406 MB</span>',
    );
    // A workspace's own line, whatever the formatter does with its breaks.
    const cells = view.replace(/\s+/g, "");
    expect(cells).toContain(
      "<spanclassName={FIGURE}>{formatCpu(workspace.cpu)}</span>",
    );
    expect(cells).toContain(
      "<spanclassName={FIGURE_STRONG}>{formatMemory(workspace.memory)}</span>",
    );
  });

  it("are the list's first two lines, and no longer one sentence above it", () => {
    const list = view.indexOf(
      '<div className="panel-scrollbar -mx-1 min-h-0 flex-1 overflow-y-auto px-1 [scrollbar-gutter:stable]">',
    );
    const rows = [...view.matchAll(/<TotalRow\n/g)].map((m) => m.index);
    expect(list).toBeGreaterThan(0);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toBeGreaterThan(list);
    expect(rows[1]).toBeLessThan(view.indexOf("{workspaces.map("));
    expect(view).not.toContain("This computer:");
    expect(view).not.toContain("Anbo:{");
  });

  it("stay on top while the list scrolls, but only in a window that can spare their two lines", () => {
    // Measured in a window 360 px high with the totals always on top: 3 px
    // were left for the workspaces.
    expect(view).toContain(
      'className="top-0 z-10 mb-1 border-b border-border/60 bg-popover pb-1.5 [@media(min-height:34rem)]:sticky"',
    );
  });

  it("keeps the heads in the list's own width", () => {
    // The same gutter classes as the list: outside them the heads stood a
    // scrollbar's width (5 px) to the right of the figures below.
    expect(view).toContain(
      '<div className="panel-scrollbar -mx-1 -mb-1.5 shrink-0 overflow-hidden px-1 [scrollbar-gutter:stable]">',
    );
  });
});
