import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, "WorkspaceDockview.tsx"), "utf8");

describe("WorkspaceDockview visual handoff", () => {
  it("restores a workspace layout before the browser chrome can paint", () => {
    expect(source).toMatch(
      /useLayoutEffect\(\(\) => \{\s*if \(!api\) return;\s*const sameDockview = loadedApiRef\.current === api;\s*if \(sameDockview && loadedSpaceRef\.current === props\.spaceId\) return;[\s\S]*?api\.fromJSON/,
    );
  });

  it("loads the space again into a Dockview put up anew", () => {
    // A hot update recreates the context the Dockview hangs from, so a new,
    // empty Dockview mounts under the same component and its loaded refs.
    // Left alone it got the tabs one by one in a single group, which was
    // then saved over the split.
    expect(source).toContain("loadedApiRef.current = api;");
    expect(source).toContain(
      "if (sameDockview && loadedSpaceRef.current !== null) {",
    );
  });

  it("synchronizes panel membership and the active panel before paint", () => {
    expect(source).toMatch(
      /useLayoutEffect\(\(\) => \{\s*if \(!api \|\| loadedSpaceRef\.current !== props\.spaceId\) return;[\s\S]*?wantedPanelIds/,
    );
    expect(source).toMatch(
      /useLayoutEffect\(\(\) => \{\s*if \(!api\) return;\s*const panel = api\.getPanel\(workspaceDockviewPanelId\(props\.activeId\)\)/,
    );
    expect(source).toContain("panel.group.focus()");
  });

  it("saves the layout on unmount before Dockview drops its panels", () => {
    // A layout cleanup runs before Dockview's passive one disposes the
    // panels; from a passive cleanup the last save came out empty.
    expect(source).toMatch(
      /useLayoutEffect\(\(\) => \{\s*if \(!api\) return;\s*return \(\) => flushPersistedLayout\(loadedSpaceRef\.current, api\);\s*\}, \[api, flushPersistedLayout\]\);/,
    );
    const passive = source.slice(
      source.indexOf("const changed = api.onDidLayoutChange"),
      source.indexOf("// The last save on unmount"),
    );
    expect(passive).not.toContain("flushPersistedLayout");
  });

  it("ignores minimized geometry and forces one stable layout on restore", () => {
    expect(source).toContain("disableAutoResizing");
    expect(source).toContain("isWindowPresentationBlocked()");
    expect(source).toContain("api.layout(width, height, true)");
    expect(source).toContain("subscribeWindowPresentation");
  });
});
