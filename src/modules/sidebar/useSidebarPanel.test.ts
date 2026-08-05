import { describe, expect, it } from "vitest";
import {
  shouldPersistSidebarCollapsed,
  shouldPersistSidebarWidth,
  shouldRestoreSidebar,
} from "./useSidebarPanel";

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
  it("restores only an unintended collapse after a visible wide resize", () => {
    expect(shouldRestoreSidebar(false, true, true, 900)).toBe(true);
    expect(shouldRestoreSidebar(true, true, true, 900)).toBe(false);
    expect(shouldRestoreSidebar(false, false, true, 900)).toBe(false);
    expect(shouldRestoreSidebar(false, true, false, 900)).toBe(false);
    expect(shouldRestoreSidebar(false, true, true, 500)).toBe(false);
  });
});
