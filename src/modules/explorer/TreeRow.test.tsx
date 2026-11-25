import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EntryRow, type EntryRowProps } from "./TreeRow";

const here = path.dirname(fileURLToPath(import.meta.url));
const explorer = readFileSync(path.join(here, "FileExplorer.tsx"), "utf8");
const flat = explorer.replace(/\s+/g, " ");
const keys = flat.slice(
  flat.indexOf("const handleKeyDown ="),
  flat.indexOf("const handleFocus ="),
);

const nothing = () => {};

function row(over: Partial<EntryRowProps> = {}) {
  return renderToStaticMarkup(
    <EntryRow
      path="/work/src"
      name="src"
      isDir
      isExpanded={false}
      depth={0}
      actions={{
        toggle: nothing,
        beginRename: nothing,
        commitRename: nothing,
        cancelRename: nothing,
      }}
      renameInProgress={false}
      isSelected={false}
      isRenaming={false}
      onOpenFile={nothing}
      onSelectPath={nothing}
      {...over}
    />,
  );
}

describe("the file tree and the keyboard", () => {
  it("keeps every row out of the Tab order", () => {
    const rows = [
      row(),
      row({ isExpanded: true }),
      row({ isSelected: true }),
      row({ isDir: false, name: "main.ts", path: "/work/main.ts" }),
    ];
    for (const html of rows) {
      expect(html.match(/<button/g)).toHaveLength(1);
      expect(html).toMatch(/<button[^>]* tabindex="-1"/);
    }
  });

  it("has one Tab stop, the list, and it shows keyboard focus", () => {
    expect(explorer.match(/tabIndex=\{0\}/g)).toHaveLength(1);
    expect(flat).toContain(
      "ref={scrollRef} tabIndex={0} onKeyDown={handleKeyDown} onFocus={handleFocus}",
    );
    expect(flat).toContain(
      "outline-none [scrollbar-gutter:stable] focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary/30",
    );
  });

  it("rings the selected row while the list has keyboard focus", () => {
    const ring =
      "group-focus-visible/tree:ring-1 group-focus-visible/tree:ring-inset group-focus-visible/tree:ring-ring/50";
    expect(row({ isSelected: true })).toContain(ring);
    expect(row()).not.toContain("group-focus-visible/tree");
    expect(flat).toContain('"group/tree panel-scrollbar');
  });

  it("hands focus that a click puts on a row to the list", () => {
    expect(flat).toContain(
      "if (e.target.tabIndex < 0) e.currentTarget.focus();",
    );
  });

  it("reads the keys only while the list itself has the focus", () => {
    // The head's buttons are outside the list: Enter on New file used to open
    // the selected row.
    const guard = keys.indexOf("if (e.target !== e.currentTarget) return;");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(keys.indexOf("switch (e.key)"));
  });

  it("opens the selected row with Space as with Enter", () => {
    expect(keys).toContain('case " ": case "Enter": {');
  });

  it("keeps a row selected while it is renamed", () => {
    expect(flat).toContain(
      "selectedPath && selectedPath !== tree.renaming && !entryIndexByPath.has(selectedPath)",
    );
  });

  it("takes the focus back when a field that held it goes away", () => {
    expect(flat).toContain(
      "const fieldOpen = Boolean( tree.renaming || tree.pendingCreate || isSearchOpen, );",
    );
    expect(flat).toContain(
      "if ( fieldWasOpen.current && !fieldOpen && document.activeElement === document.body ) { scrollRef.current?.focus(); }",
    );
  });
});
