import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (file: string) => readFileSync(path.join(here, file), "utf8");
const view = read("UsageDialog.tsx");

describe("the Task Manager", () => {
  it("is called Task Manager wherever the user reads its name", () => {
    expect(view).toMatch(/Task Manager\s+<\/DialogTitle>/);
    expect(read("../statusbar/StatusBar.tsx")).toContain(
      "<span>Task Manager</span>",
    );
    expect(read("../command-palette/commands.ts")).toContain(
      'title: "Task Manager: Memory and CPU by workspace"',
    );
    expect(read("../shortcuts/shortcuts.ts")).toContain(
      'label: "Open Task Manager (memory and CPU by workspace)"',
    );
    expect(read("../spaces/SpaceSwitcher.tsx")).toContain(
      "or resume it in Task Manager",
    );
  });

  it("opens with every workspace folded to one line; a click opens one", () => {
    expect(view).toContain(
      "const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());",
    );
    expect(view).toContain(
      "const isCollapsed = !opened.has(workspace.spaceId);",
    );
    expect(view).not.toContain("runsNothing");
  });
});
