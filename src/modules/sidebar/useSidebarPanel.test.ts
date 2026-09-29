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
