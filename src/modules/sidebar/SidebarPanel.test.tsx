import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const seen: Array<Record<string, unknown>> = [];

vi.mock("@/components/ui/resizable", () => ({
  ResizablePanel: (props: Record<string, unknown>) => {
    seen.push(props);
    return null;
  },
}));

import { SidebarPanel } from "./SidebarPanel";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, "SidebarPanel.tsx"), "utf8");

describe("SidebarPanel", () => {
  it("opens at the size it is told when it mounts and passes the rest on", () => {
    seen.length = 0;
    const initialSize = vi.fn(() => "304px");
    renderToStaticMarkup(
      <SidebarPanel
        id="sidebar"
        initialSize={initialSize}
        minSize="220px"
        maxSize="480px"
        collapsible
      />,
    );
    expect(initialSize).toHaveBeenCalledTimes(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      id: "sidebar",
      defaultSize: "304px",
      minSize: "220px",
      maxSize: "480px",
      collapsible: true,
    });
    expect(seen[0]).not.toHaveProperty("initialSize");
  });

  it("keeps that size for as long as it is mounted", () => {
    // Seen live with a real mouse: handed a default size that followed the
    // last dragged width, the panels library registered the panel again at
    // the first render after a drag and ended the drag under way, so every
    // second drag of the separator stopped after its first few pixels. State
    // read once by its initializer cannot change under a mounted panel; a
    // prop passed straight through can.
    expect(source).toMatch(/const \[defaultSize\] = useState\(initialSize\);/);
    expect(source).toMatch(/defaultSize=\{defaultSize\}/);
    expect(source).not.toMatch(/defaultSize=\{initialSize/);
  });
});
