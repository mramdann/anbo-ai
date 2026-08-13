import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, "WorkspaceDockview.tsx"), "utf8");

describe("WorkspaceDockview visual handoff", () => {
  it("restores a workspace layout before the browser chrome can paint", () => {
    expect(source).toMatch(
      /useLayoutEffect\(\(\) => \{\s*if \(!api \|\| loadedSpaceRef\.current === props\.spaceId\) return;[\s\S]*?api\.fromJSON/,
    );
  });

  it("synchronizes panel membership and the active panel before paint", () => {
    expect(source).toMatch(
      /useLayoutEffect\(\(\) => \{\s*if \(!api \|\| loadedSpaceRef\.current !== props\.spaceId\) return;[\s\S]*?wantedPanelIds/,
    );
    expect(source).toMatch(
      /useLayoutEffect\(\(\) => \{\s*if \(!api\) return;\s*const panel = api\.getPanel\(workspaceDockviewPanelId\(props\.activeId\)\)/,
    );
  });
});
