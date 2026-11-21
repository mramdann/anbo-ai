import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  shouldPersistSidebarCollapsed,
  shouldPersistSidebarWidth,
  shouldRestoreSidebar,
  shouldRestoreSidebarWidth,
} from "./useSidebarPanel";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, "useSidebarPanel.ts"), "utf8");
const appSource = readFileSync(path.join(here, "../../app/App.tsx"), "utf8");

describe("shouldPersistSidebarWidth", () => {
  it("only persists a positive width from direct user interaction", () => {
    expect(shouldPersistSidebarWidth(320, true)).toBe(true);
    expect(shouldPersistSidebarWidth(320, false)).toBe(false);
    expect(shouldPersistSidebarWidth(0, true)).toBe(false);
  });
});

describe("shouldPersistSidebarCollapsed", () => {
  it("ignores container-driven resize events such as window minimization", () => {
    expect(shouldPersistSidebarCollapsed(false)).toBe(false);
    expect(shouldPersistSidebarCollapsed(true)).toBe(true);
  });
});

describe("shouldRestoreSidebar", () => {
  it("preserves the sidebar pixel width when the window group resizes", () => {
    expect(appSource).toMatch(
      /id="sidebar"[\s\S]*?groupResizeBehavior="preserve-pixel-size"/,
    );
  });

  it("restores only an unintended collapse after a visible wide resize", () => {
    expect(shouldRestoreSidebar(false, true, true, 900)).toBe(true);
    expect(shouldRestoreSidebar(true, true, true, 900)).toBe(false);
    expect(shouldRestoreSidebar(false, false, true, 900)).toBe(false);
    expect(shouldRestoreSidebar(false, true, false, 900)).toBe(false);
    expect(shouldRestoreSidebar(false, true, true, 500)).toBe(false);
  });

  it("restores synchronously before the window presentation cover is removed", () => {
    expect(source).toContain("subscribeWindowPresentation");
    expect(source).toContain('if (next === "ready") restoreSidebarNow()');
  });
});

describe("shouldRestoreSidebarWidth", () => {
  it("gives back the chosen width after a minimize squeezed the panel", () => {
    // Seen live: the stored width stayed 360.8 px while the panel kept 203 px.
    expect(
      shouldRestoreSidebarWidth(false, false, 203, 360.8, true, 1920),
    ).toBe(true);
    expect(source).toMatch(
      /const restoreSidebarNow[\s\S]*?shouldRestoreSidebarWidth\([\s\S]*?panel\.resize/,
    );
  });

  it("leaves a collapsed, hidden or already sized panel and narrow windows alone", () => {
    expect(shouldRestoreSidebarWidth(true, false, 203, 360.8, true, 1920)).toBe(
      false,
    );
    expect(shouldRestoreSidebarWidth(false, true, 0, 360.8, true, 1920)).toBe(
      false,
    );
    expect(
      shouldRestoreSidebarWidth(false, false, 360.8, 360.8, true, 1920),
    ).toBe(false);
    expect(
      shouldRestoreSidebarWidth(false, false, 360.5, 360.8, true, 1920),
    ).toBe(false);
    expect(
      shouldRestoreSidebarWidth(false, false, 203, 360.8, false, 1920),
    ).toBe(false);
    expect(shouldRestoreSidebarWidth(false, false, 203, 360.8, true, 500)).toBe(
      false,
    );
  });
});

describe("the sidebar's width when the app starts", () => {
  const panelTag = (id: string, component = "ResizablePanel") =>
    appSource.match(
      new RegExp(String.raw`<${component}\s+id="${id}"[^>]*>`),
    )?.[0];

  it("opens at the stored width, in pixels", () => {
    expect(source).toMatch(
      /const sidebarInitialSize = useCallback\(\s*\(\) =>\s*\(initialSidebarCollapsed \? "0px" : `\$\{sidebarWidthRef\.current\}px`\),/,
    );
    expect(panelTag("sidebar", "SidebarPanel")).toMatch(
      /initialSize=\{sidebarInitialSize\}/,
    );
  });

  it("never hands the mounted sidebar panel a default size that follows the drags", () => {
    // Seen live, with a real mouse too: every second drag of the separator
    // stopped after its first few pixels. The panel had the last dragged
    // width as its default size; the panels library registers a panel again
    // when that changes, which ends a drag under way, and in an idle window
    // the first render after a drag is the one the next drag's press causes.
    const sidebar = panelTag("sidebar", "SidebarPanel");
    expect(sidebar).toBeDefined();
    expect(sidebar).not.toContain("defaultSize");
    expect(panelTag("sidebar")).toBeUndefined();
    expect(appSource).not.toContain("sidebarWidthRef");
  });

  it("gives the workspace panel what is left, so that width is not scaled", () => {
    // Seen live: with 78% for the workspace a stored 304 px came up as 324 px
    // in a 1920 px window, 338 px in a 2560 px one and 288 px in an 1100 px
    // one. Default sizes that do not add up to the group are scaled by the
    // panels library; a panel without one takes the rest.
    const workspace = panelTag("workspace");
    expect(workspace).toBeDefined();
    expect(workspace).not.toContain("defaultSize");
    expect(workspace).toContain('minSize="30%"');
  });
});
